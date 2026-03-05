// On Track - Lithic API Routes
// Quick Draw intervention system endpoints

import { Router, Request, Response, NextFunction } from 'express';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../server';
import {
  createInterventionCard,
  getCard,
  updateCardState,
  handleAuthorizationWebhook,
  handleUserDecision,
  simulateAuthorizationEvent,
  verifyWebhookSignature,
} from '../services/lithicService';
import { calculateInterventionSetback } from '../services/setbackCalculator';
import { ApiError } from '../middleware/errorHandler';

const router = Router();

// ============================================
// CARD MANAGEMENT
// ============================================

router.post('/cards', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { type, memo, spendLimit, spendLimitDuration } = req.body;

    const card = await createInterventionCard(userId, {
      type: type || 'MERCHANT_LOCKED',
      memo,
      spendLimit,
      spendLimitDuration: spendLimitDuration || 'MONTHLY',
    });

    res.status(201).json({
      success: true,
      data: card,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/cards/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const card = await getCard(token);

    res.json({
      success: true,
      data: card,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/cards/:token/state', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const { state } = req.body;

    if (!['OPEN', 'PAUSED', 'CLOSED'].includes(state)) {
      throw new ApiError(400, 'INVALID_STATE', 'State must be OPEN, PAUSED, or CLOSED');
    }

    await updateCardState(token, state);

    res.json({
      success: true,
      message: `Card state updated to ${state}`,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// WEBHOOK ENDPOINTS
// ============================================

router.post('/webhooks/authorization', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-lithic-signature'] as string;
    const payload = JSON.stringify(req.body);
    
    if (!verifyWebhookSignature(payload, signature || '', process.env.LITHIC_WEBHOOK_SECRET || '')) {
      throw new ApiError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    }

    const event = req.body;
    const result = await handleAuthorizationWebhook(event);

    res.json({
      decision: result.decision,
      decline_reason: result.declineReason,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// INTERVENTION MANAGEMENT
// ============================================

router.get('/interventions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const interventions = await prisma.intervention.findMany({
      where: { userId },
      include: {
        targetLiability: {
          select: {
            creditorName: true,
            apr: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: interventions,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/interventions/:id/decision', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { id } = req.params;
    const { decision } = req.body;

    if (!['APPROVE', 'DECLINE'].includes(decision)) {
      throw new ApiError(400, 'INVALID_DECISION', 'Decision must be APPROVE or DECLINE');
    }

    await handleUserDecision(id, userId, decision);

    res.json({
      success: true,
      message: `Intervention ${decision.toLowerCase()}d successfully`,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/interventions/pending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const interventions = await prisma.intervention.findMany({
      where: {
        userId,
        decision: 'PENDING',
      },
      include: {
        targetLiability: {
          select: {
            creditorName: true,
            apr: true,
            currentBalance: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: interventions,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SANDBOX TESTING ENDPOINTS
// ============================================

router.post('/sandbox/simulate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new ApiError(403, 'FORBIDDEN', 'Sandbox endpoints not available in production');
    }

    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user?.lithicCardToken) {
      throw new ApiError(400, 'NO_CARD', 'User has no Lithic card linked');
    }

    const { amount, merchantName, merchantCategory } = req.body;

    const event = simulateAuthorizationEvent(
      user.lithicCardToken,
      amount || 100,
      merchantName || 'Test Merchant',
      merchantCategory || '5812'
    );

    const result = await handleAuthorizationWebhook(event);

    res.json({
      success: true,
      data: {
        simulatedEvent: event,
        decision: result.decision,
        declineReason: result.declineReason,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/sandbox/test-setback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new ApiError(403, 'FORBIDDEN', 'Sandbox endpoints not available in production');
    }

    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { purchaseAmount } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        liabilities: {
          where: {
            status: 'ACTIVE',
            isHighPriority: true,
          },
          orderBy: { apr: 'desc' },
          take: 1,
        },
      },
    });

    if (!user) {
      throw new ApiError(404, 'NOT_FOUND', 'User not found');
    }

    const highestPriorityLiability = user.liabilities[0] || null;
    
    const setbackResult = calculateInterventionSetback({
      purchaseAmount: new Decimal(purchaseAmount),
      user: {
        disposableIncome: user.disposableIncome,
        freedomDate: user.freedomDate || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
      highestPriorityLiability,
    });

    res.json({
      success: true,
      data: {
        purchaseAmount,
        userDisposableIncome: user.disposableIncome,
        highestPriorityDebt: highestPriorityLiability ? {
          name: highestPriorityLiability.creditorName,
          apr: highestPriorityLiability.apr,
          balance: highestPriorityLiability.currentBalance,
        } : null,
        setbackAnalysis: setbackResult,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
