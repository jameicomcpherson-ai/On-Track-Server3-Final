// On Track - Lithic Integration Service
// Real-time transaction authorization & intervention system

import axios, { AxiosInstance } from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../server';
import { calculateInterventionSetback } from './setbackCalculator';
import {
  LithicCardRequest,
  LithicCardResponse,
  LithicAuthorizationEvent,
  LithicDeclineRequest,
  SweepResult,
} from '../types';

// ============================================
// LITHIC API CONFIGURATION
// ============================================

const LITHIC_API_URL = process.env.LITHIC_API_URL || 'https://api.lithic.com/v1';
const LITHIC_API_KEY = process.env.LITHIC_API_KEY || '';

// Create axios instance for Lithic API
const lithicClient: AxiosInstance = axios.create({
  baseURL: LITHIC_API_URL,
  headers: {
    'Authorization': `Api-Key ${LITHIC_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

// ============================================
// CARD MANAGEMENT
// ============================================

/**
 * Create a new Lithic card for a user
 * This is the "intervention card" that triggers Quick Draw
 */
export async function createInterventionCard(
  userId: string,
  request: LithicCardRequest
): Promise<LithicCardResponse> {
  try {
    const response = await lithicClient.post('/cards', {
      type: request.type,
      memo: request.memo || 'On Track Intervention Card',
      spend_limit: request.spendLimit,
      spend_limit_duration: request.spendLimitDuration,
      state: request.state || 'OPEN',
    });

    const cardData = response.data;

    // Update user record with card token
    await prisma.user.update({
      where: { id: userId },
      data: {
        lithicCardToken: cardData.token,
        lithicAccountToken: cardData.account_token,
      },
    });

    // Log the card creation
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'LITHIC_CARD_CREATED',
        eventDescription: `Created ${request.type} intervention card`,
        success: true,
      },
    });

    return {
      token: cardData.token,
      lastFour: cardData.last_four,
      spendLimit: cardData.spend_limit,
      spendLimitDuration: cardData.spend_limit_duration,
      state: cardData.state,
      type: cardData.type,
    };
  } catch (error) {
    console.error('Failed to create Lithic card:', error);
    throw new Error('Failed to create intervention card');
  }
}

/**
 * Get card details from Lithic
 */
export async function getCard(cardToken: string): Promise<LithicCardResponse> {
  try {
    const response = await lithicClient.get(`/cards/${cardToken}`);
    const cardData = response.data;

    return {
      token: cardData.token,
      lastFour: cardData.last_four,
      spendLimit: cardData.spend_limit,
      spendLimitDuration: cardData.spend_limit_duration,
      state: cardData.state,
      type: cardData.type,
    };
  } catch (error) {
    console.error('Failed to get card details:', error);
    throw new Error('Failed to retrieve card details');
  }
}

/**
 * Update card state (pause/unpause/close)
 */
export async function updateCardState(
  cardToken: string,
  state: 'OPEN' | 'PAUSED' | 'CLOSED'
): Promise<void> {
  try {
    await lithicClient.patch(`/cards/${cardToken}`, {
      state,
    });
  } catch (error) {
    console.error('Failed to update card state:', error);
    throw new Error('Failed to update card state');
  }
}

// ============================================
// TRANSACTION AUTHORIZATION WEBHOOK
// ============================================

/**
 * Handle incoming Lithic authorization webhook
 * This is the CORE of the Quick Draw system
 */
export async function handleAuthorizationWebhook(
  event: LithicAuthorizationEvent
): Promise<{ decision: 'APPROVE' | 'DECLINE'; declineReason?: string }> {
  const { token, cardToken, amount, merchant, status } = event;

  // Only process pending authorizations
  if (status !== 'PENDING') {
    return { decision: 'APPROVE' };
  }

  try {
    // Find user by card token
    const user = await prisma.user.findFirst({
      where: { lithicCardToken: cardToken },
      include: {
        liabilities: {
          where: {
            status: 'ACTIVE',
            isHighPriority: true,
          },
          orderBy: {
            apr: 'desc',
          },
          take: 1,
        },
      },
    });

    if (!user) {
      console.warn(`No user found for card token: ${cardToken}`);
      return { decision: 'APPROVE' };
    }

    // Skip small transactions (under $10)
    if (amount < 10) {
      return { decision: 'APPROVE' };
    }

    // Calculate setback for this purchase
    const highestPriorityLiability = user.liabilities[0] || null;
    
    const setbackResult = calculateInterventionSetback({
      purchaseAmount: new Decimal(amount),
      user: {
        disposableIncome: user.disposableIncome,
        freedomDate: user.freedomDate || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
      highestPriorityLiability,
    });

    // Create intervention record
    const intervention = await prisma.intervention.create({
      data: {
        userId: user.id,
        originalAmount: new Decimal(amount),
        merchantName: merchant.descriptor,
        merchantCategory: merchant.mcc,
        decision: 'PENDING',
        setbackDays: setbackResult.setbackDays,
        freedomDateImpact: setbackResult.freedomDateImpact,
        targetLiabilityId: highestPriorityLiability?.id || null,
        lithicTransactionToken: token,
      },
    });

    // Log the intervention trigger
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        eventType: 'INTERVENTION_TRIGGERED',
        eventDescription: `Transaction of $${amount} at ${merchant.descriptor} triggered intervention`,
        success: true,
      },
    });

    // Make decision based on setback calculation
    if (setbackResult.recommendedAction === 'DECLINE') {
      // Auto-decline high-impact purchases
      await declineTransaction(token, 'CUSTOM', setbackResult.warningMessage);
      
      await prisma.intervention.update({
        where: { id: intervention.id },
        data: {
          decision: 'DECLINED',
          lithicDeclinedAt: new Date(),
        },
      });

      // Trigger sweep of funds
      await sweepDeclinedAmount(user.id, new Decimal(amount), intervention.id);

      return { 
        decision: 'DECLINE', 
        declineReason: setbackResult.warningMessage 
      };
    }

    // For APPROVE_WITH_WARNING, we still approve but the frontend will show warning
    // The user can still decline via the app within a short window
    return { decision: 'APPROVE' };

  } catch (error) {
    console.error('Error handling authorization webhook:', error);
    // Fail open - approve if there's an error
    return { decision: 'APPROVE' };
  }
}

/**
 * Decline a Lithic transaction
 */
export async function declineTransaction(
  transactionToken: string,
  reason: 'CARD_PAUSED' | 'CARD_CLOSED' | 'SINGLE_USE_RECHARGED' | 'CUSTOM',
  customMessage?: string
): Promise<void> {
  try {
    const declineRequest: LithicDeclineRequest = {
      transactionToken,
      reason,
    };

    if (reason === 'CUSTOM' && customMessage) {
      // Note: Lithic may have limitations on custom decline messages
      // This is implementation-specific
    }

    await lithicClient.post(`/transactions/${transactionToken}/decline`, declineRequest);
  } catch (error) {
    console.error('Failed to decline transaction:', error);
    throw new Error('Failed to decline transaction');
  }
}

// ============================================
// SWEEP LOGIC (VoPay Integration)
// ============================================

/**
 * Sweep declined amount from user's funding source
 * This is the "Debt-Crusher Automation"
 */
async function sweepDeclinedAmount(
  userId: string,
  amount: Decimal,
  interventionId: string
): Promise<SweepResult> {
  try {
    // Get user's VoPay funding source
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user?.vopayFundingSourceId) {
      return {
        success: false,
        errorMessage: 'No funding source linked',
      };
    }

    // TODO: Implement actual VoPay API call
    // For now, we'll simulate the sweep
    const mockVoPayTransactionId = `vopay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Update intervention with sweep details
    await prisma.intervention.update({
      where: { id: interventionId },
      data: {
        vopayTransactionId: mockVoPayTransactionId,
        sweptAmount: amount,
        sweptAt: new Date(),
      },
    });

    // Create a payment record for the highest priority liability
    const highestPriorityLiability = await prisma.liability.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        isHighPriority: true,
      },
      orderBy: { apr: 'desc' },
    });

    if (highestPriorityLiability) {
      await prisma.payment.create({
        data: {
          liabilityId: highestPriorityLiability.id,
          amount,
          principalAmount: amount,
          interestAmount: new Decimal(0),
          source: 'INTERVENTION_SWEEP',
          sourceReference: interventionId,
          status: 'PENDING',
          vopayTransactionId: mockVoPayTransactionId,
        },
      });
    }

    return {
      success: true,
      vopayTransactionId: mockVoPayTransactionId,
      amount,
    };

  } catch (error) {
    console.error('Failed to sweep declined amount:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================
// USER DECISION HANDLING
// ============================================

/**
 * Handle user's decision on a pending intervention
 */
export async function handleUserDecision(
  interventionId: string,
  userId: string,
  decision: 'APPROVE' | 'DECLINE'
): Promise<void> {
  const intervention = await prisma.intervention.findFirst({
    where: {
      id: interventionId,
      userId,
      decision: 'PENDING',
    },
  });

  if (!intervention) {
    throw new Error('Intervention not found or already processed');
  }

  if (decision === 'DECLINE') {
    // Decline the Lithic transaction
    if (intervention.lithicTransactionToken) {
      await declineTransaction(
        intervention.lithicTransactionToken,
        'CUSTOM',
        'User declined via On Track app'
      );
    }

    // Update intervention
    await prisma.intervention.update({
      where: { id: interventionId },
      data: {
        decision: 'DECLINED',
        lithicDeclinedAt: new Date(),
        userRespondedAt: new Date(),
      },
    });

    // Sweep the funds
    await sweepDeclinedAmount(userId, intervention.originalAmount, interventionId);

  } else {
    // User approved - let the transaction go through
    await prisma.intervention.update({
      where: { id: interventionId },
      data: {
        decision: 'APPROVED',
        userRespondedAt: new Date(),
      },
    });
  }

  // Log the user decision
  await prisma.auditLog.create({
    data: {
      userId,
      eventType: 'INTERVENTION_DECISION',
      eventDescription: `User ${decision.toLowerCase()}d intervention`,
      success: true,
    },
  });
}

// ============================================
// SANDBOX TESTING
// ============================================

/**
 * Simulate a Lithic authorization event for testing
 */
export function simulateAuthorizationEvent(
  cardToken: string,
  amount: number,
  merchantName: string,
  merchantCategory: string
): LithicAuthorizationEvent {
  return {
    token: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    cardToken,
    amount,
    currency: 'USD',
    merchant: {
      descriptor: merchantName,
      city: 'New York',
      country: 'USA',
      mcc: merchantCategory,
    },
    status: 'PENDING',
    created: new Date().toISOString(),
  };
}

// ============================================
// WEBHOOK VERIFICATION
// ============================================

/**
 * Verify Lithic webhook signature
 * IMPORTANT: Implement this in production to ensure webhooks are from Lithic
 */
export function verifyWebhookSignature(
  _payload: string,
  _signature: string,
  _secret: string
): boolean {
  // TODO: Implement HMAC signature verification
  // This is critical for production security
  
  // For sandbox testing, we skip verification
  if (process.env.NODE_ENV === 'development') {
    return true;
  }

  // Implement actual verification logic here
  // const crypto = require('crypto');
  // const expectedSignature = crypto
  //   .createHmac('sha256', secret)
  //   .update(payload)
  //   .digest('hex');
  // return signature === expectedSignature;

  return true; // Placeholder
}
