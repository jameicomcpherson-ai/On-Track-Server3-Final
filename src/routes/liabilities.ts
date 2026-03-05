// On Track - Liabilities (Debts) Routes
// The "8% Engine" - High-priority debt detection & management

import { Router, Request, Response, NextFunction } from 'express';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../server';
import { ApiError } from '../middleware/errorHandler';

const router = Router();

// The 8% threshold for high-priority debt
const HIGH_PRIORITY_THRESHOLD = new Decimal(8.0);

// ============================================
// GET ALL LIABILITIES
// ============================================

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const liabilities = await prisma.liability.findMany({
      where: { userId },
      orderBy: [
        { isHighPriority: 'desc' },
        { apr: 'desc' },
      ],
    });

    res.json({
      success: true,
      data: liabilities,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// CREATE LIABILITY
// ============================================

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const {
      creditorName,
      creditorType,
      currentBalance,
      originalBalance,
      apr,
      minimumPayment,
      nickname,
    } = req.body;

    // Validate required fields
    if (!creditorName || !currentBalance || !apr) {
      throw new ApiError(400, 'MISSING_FIELDS', 'Creditor name, balance, and APR are required');
    }

    // Determine if high priority (APR > 8%)
    const isHighPriority = new Decimal(apr).greaterThan(HIGH_PRIORITY_THRESHOLD);

    // Create liability
    const liability = await prisma.liability.create({
      data: {
        userId,
        creditorName,
        creditorType: creditorType || 'OTHER',
        currentBalance: new Decimal(currentBalance),
        originalBalance: originalBalance ? new Decimal(originalBalance) : new Decimal(currentBalance),
        apr: new Decimal(apr),
        minimumPayment: minimumPayment ? new Decimal(minimumPayment) : new Decimal(0),
        isHighPriority,
        nickname,
      },
    });

    // Recalculate priority ranks
    await recalculatePriorityRanks(userId);

    // Log liability creation
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'LIABILITY_ADDED',
        eventDescription: `Added liability: ${creditorName}`,
        success: true,
      },
    });

    res.status(201).json({
      success: true,
      data: liability,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET SINGLE LIABILITY
// ============================================

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { id } = req.params;

    const liability = await prisma.liability.findFirst({
      where: { id, userId },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!liability) {
      throw new ApiError(404, 'NOT_FOUND', 'Liability not found');
    }

    res.json({
      success: true,
      data: liability,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// UPDATE LIABILITY
// ============================================

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { id } = req.params;
    const updateData = req.body;

    // Find existing liability
    const existing = await prisma.liability.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      throw new ApiError(404, 'NOT_FOUND', 'Liability not found');
    }

    // Build update object
    const data: any = {};
    
    if (updateData.creditorName) data.creditorName = updateData.creditorName;
    if (updateData.creditorType) data.creditorType = updateData.creditorType;
    if (updateData.currentBalance) data.currentBalance = new Decimal(updateData.currentBalance);
    if (updateData.apr) {
      data.apr = new Decimal(updateData.apr);
      data.isHighPriority = data.apr.greaterThan(HIGH_PRIORITY_THRESHOLD);
    }
    if (updateData.minimumPayment) data.minimumPayment = new Decimal(updateData.minimumPayment);
    if (updateData.nickname !== undefined) data.nickname = updateData.nickname;

    // Update liability
    const liability = await prisma.liability.update({
      where: { id },
      data,
    });

    // Recalculate priority ranks if APR changed
    if (updateData.apr) {
      await recalculatePriorityRanks(userId);
    }

    // Log update
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'LIABILITY_UPDATED',
        eventDescription: `Updated liability: ${liability.creditorName}`,
        success: true,
      },
    });

    res.json({
      success: true,
      data: liability,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// DELETE LIABILITY
// ============================================

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { id } = req.params;

    // Find existing liability
    const existing = await prisma.liability.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      throw new ApiError(404, 'NOT_FOUND', 'Liability not found');
    }

    // Delete liability
    await prisma.liability.delete({
      where: { id },
    });

    // Recalculate priority ranks
    await recalculatePriorityRanks(userId);

    res.json({
      success: true,
      message: 'Liability deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// CAPTURE LIABILITY (Mark as Paid Off)
// ============================================

router.post('/:id/capture', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { id } = req.params;

    // Find liability
    const liability = await prisma.liability.findFirst({
      where: { id, userId },
    });

    if (!liability) {
      throw new ApiError(404, 'NOT_FOUND', 'Liability not found');
    }

    if (liability.status === 'CAPTURED') {
      throw new ApiError(400, 'ALREADY_CAPTURED', 'Liability already captured');
    }

    // Update liability
    const updated = await prisma.liability.update({
      where: { id },
      data: {
        status: 'CAPTURED',
        capturedAt: new Date(),
        currentBalance: new Decimal(0),
      },
    });

    // Recalculate priority ranks
    await recalculatePriorityRanks(userId);

    // Log capture
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'LIABILITY_CAPTURED',
        eventDescription: `Captured liability: ${liability.creditorName}`,
        success: true,
      },
    });

    res.json({
      success: true,
      data: updated,
      message: `Congratulations! You've captured ${liability.creditorName}!`,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET DEBT ANALYSIS (The "8% Engine")
// ============================================

router.get('/analysis/data', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    // Get all active liabilities
    const liabilities = await prisma.liability.findMany({
      where: {
        userId,
        status: 'ACTIVE',
      },
      orderBy: { apr: 'desc' },
    });

    // Calculate totals
    const totalBalance = liabilities.reduce(
      (sum: Decimal, l: any) => sum.plus(l.currentBalance),
      new Decimal(0)
    );

    const totalMinimumPayment = liabilities.reduce(
      (sum: Decimal, l: any) => sum.plus(l.minimumPayment),
      new Decimal(0)
    );

    // Calculate weighted average APR
    const weightedAprSum = liabilities.reduce(
      (sum: Decimal, l: any) => sum.plus(l.currentBalance.times(l.apr)),
      new Decimal(0)
    );
    const weightedAvgApr = totalBalance.greaterThan(0)
      ? weightedAprSum.dividedBy(totalBalance)
      : new Decimal(0);

    // High priority targets (APR > 8%)
    const highPriorityTargets = liabilities.filter((l: any) => l.isHighPriority);
    const totalHighPriorityDebt = highPriorityTargets.reduce(
      (sum: Decimal, l: any) => sum.plus(l.currentBalance),
      new Decimal(0)
    );

    // Calculate estimated payoff dates
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { disposableIncome: true },
    });

    const monthlyPayment = user?.disposableIncome || new Decimal(0);
    let estimatedPayoffMonths = 0;
    
    if (monthlyPayment.greaterThan(0) && totalBalance.greaterThan(0)) {
      // Simple estimation: balance / monthly payment
      // In production, use the full payoff simulation
      estimatedPayoffMonths = Math.ceil(
        totalBalance.dividedBy(monthlyPayment).toNumber()
      );
    }

    const estimatedPayoffDate = new Date();
    estimatedPayoffDate.setMonth(estimatedPayoffDate.getMonth() + estimatedPayoffMonths);

    res.json({
      success: true,
      data: {
        summary: {
          totalLiabilities: liabilities.length,
          totalBalance,
          totalMinimumPayment,
          weightedAvgApr: weightedAvgApr.toFixed(2),
          estimatedPayoffMonths,
          estimatedPayoffDate,
        },
        highPriorityAnalysis: {
          targetCount: highPriorityTargets.length,
          totalHighPriorityDebt,
          threshold: HIGH_PRIORITY_THRESHOLD.toString(),
          targets: highPriorityTargets.map((l: any, index: number) => ({
            rank: index + 1,
            id: l.id,
            name: l.creditorName,
            balance: l.currentBalance,
            apr: l.apr,
            monthlyInterest: l.currentBalance.times(l.apr).dividedBy(100).dividedBy(12).toFixed(2),
          })),
        },
        allLiabilities: liabilities.map((l: any, index: number) => ({
          rank: index + 1,
          ...l,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Recalculate priority ranks for all user liabilities
 * Uses the Debt Avalanche method (highest interest first)
 */
async function recalculatePriorityRanks(userId: string): Promise<void> {
  const liabilities = await prisma.liability.findMany({
    where: {
      userId,
      status: 'ACTIVE',
    },
    orderBy: { apr: 'desc' },
  });

  // Update priority ranks
  for (let i = 0; i < liabilities.length; i++) {
    await prisma.liability.update({
      where: { id: liabilities[i].id },
      data: { priorityRank: i + 1 },
    });
  }
}

export default router;
