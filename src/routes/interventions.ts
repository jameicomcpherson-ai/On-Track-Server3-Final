// On Track - Interventions Routes
// Quick Draw intervention history and analytics

import { Router, Request, Response, NextFunction } from 'express';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../server';
import { ApiError } from '../middleware/errorHandler';

const router = Router();

// ============================================
// GET ALL INTERVENTIONS
// ============================================

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { page = '1', limit = '20', decision } = req.query;

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = { userId };
    if (decision) {
      where.decision = decision;
    }

    const [interventions, total] = await Promise.all([
      prisma.intervention.findMany({
        where,
        include: {
          targetLiability: {
            select: {
              creditorName: true,
              apr: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.intervention.count({ where }),
    ]);

    res.json({
      success: true,
      data: interventions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET INTERVENTION STATS
// ============================================

router.get('/stats/data', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    // Get all interventions
    const interventions = await prisma.intervention.findMany({
      where: { userId },
    });

    // Calculate stats
    const totalInterventions = interventions.length;
    const declinedCount = interventions.filter((i: any) => i.decision === 'DECLINED').length;
    const approvedCount = interventions.filter((i: any) => i.decision === 'APPROVED').length;
    const pendingCount = interventions.filter((i: any) => i.decision === 'PENDING').length;

    // Calculate total money saved from declined interventions
    const totalSaved = interventions
      .filter((i: any) => i.decision === 'DECLINED')
      .reduce((sum: Decimal, i: any) => sum.plus(i.originalAmount), new Decimal(0));

    // Calculate total setback days prevented
    const totalSetbackDaysPrevented = interventions
      .filter((i: any) => i.decision === 'DECLINED')
      .reduce((sum: Decimal, i: any) => sum.plus(i.setbackDays), new Decimal(0));

    // Calculate average setback per intervention
    const avgSetbackDays = totalInterventions > 0
      ? interventions.reduce((sum: Decimal, i: any) => sum.plus(i.setbackDays), new Decimal(0))
          .dividedBy(totalInterventions)
      : new Decimal(0);

    // Get monthly breakdown
    const monthlyStats = await prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as count,
        SUM(CASE WHEN decision = 'DECLINED' THEN 1 ELSE 0 END) as declined,
        SUM(CASE WHEN decision = 'APPROVED' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN decision = 'DECLINED' THEN original_amount ELSE 0 END) as saved
      FROM interventions
      WHERE user_id = ${userId}
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
      LIMIT 12
    `;

    // Get top merchants that triggered interventions
    const topMerchants = await prisma.$queryRaw`
      SELECT 
        merchant_name,
        COUNT(*) as count,
        SUM(original_amount) as total_amount,
        AVG(setback_days) as avg_setback
      FROM interventions
      WHERE user_id = ${userId}
      GROUP BY merchant_name
      ORDER BY count DESC
      LIMIT 10
    `;

    res.json({
      success: true,
      data: {
        summary: {
          totalInterventions,
          declinedCount,
          approvedCount,
          pendingCount,
          totalSaved,
          totalSetbackDaysPrevented: totalSetbackDaysPrevented.toFixed(2),
          avgSetbackDays: avgSetbackDays.toFixed(2),
        },
        monthlyStats,
        topMerchants,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET SINGLE INTERVENTION
// ============================================

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { id } = req.params;

    const intervention = await prisma.intervention.findFirst({
      where: { id, userId },
      include: {
        targetLiability: true,
      },
    });

    if (!intervention) {
      throw new ApiError(404, 'NOT_FOUND', 'Intervention not found');
    }

    res.json({
      success: true,
      data: intervention,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET PENDING INTERVENTIONS
// ============================================

router.get('/pending/list', async (req: Request, res: Response, next: NextFunction) => {
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
// MAKE DECISION ON INTERVENTION
// ============================================

router.post('/:id/decision', async (req: Request, res: Response, next: NextFunction) => {
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

    // Find intervention
    const intervention = await prisma.intervention.findFirst({
      where: {
        id,
        userId,
        decision: 'PENDING',
      },
    });

    if (!intervention) {
      throw new ApiError(404, 'NOT_FOUND', 'Intervention not found or already processed');
    }

    // Update intervention
    const updated = await prisma.intervention.update({
      where: { id },
      data: {
        decision: decision === 'APPROVE' ? 'APPROVED' : 'DECLINED',
        userRespondedAt: new Date(),
      },
    });

    // If declined, create a payment to the target liability
    if (decision === 'DECLINE' && intervention.targetLiabilityId) {
      await prisma.payment.create({
        data: {
          liabilityId: intervention.targetLiabilityId,
          amount: intervention.originalAmount,
          principalAmount: intervention.originalAmount,
          interestAmount: new Decimal(0),
          source: 'INTERVENTION_SWEEP',
          sourceReference: id,
          status: 'PENDING',
        },
      });
    }

    // Log the decision
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'INTERVENTION_DECISION',
        eventDescription: `User ${decision.toLowerCase()}d intervention`,
        success: true,
      },
    });

    res.json({
      success: true,
      data: updated,
      message: `Intervention ${decision.toLowerCase()}d successfully`,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET INTERVENTION TIMELINE
// ============================================

router.get('/timeline/data', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { days = '30' } = req.query;
    const daysNum = parseInt(days as string, 10);
    const startDate = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000);

    const interventions = await prisma.intervention.findMany({
      where: {
        userId,
        createdAt: {
          gte: startDate,
        },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        originalAmount: true,
        decision: true,
        setbackDays: true,
        merchantName: true,
      },
    });

    // Group by date
    const grouped = interventions.reduce((acc: any, intervention: any) => {
      const date = intervention.createdAt.toISOString().split('T')[0];
      if (!acc[date]) {
        acc[date] = {
          date,
          total: 0,
          declined: 0,
          approved: 0,
          totalAmount: new Decimal(0),
          savedAmount: new Decimal(0),
          totalSetback: new Decimal(0),
        };
      }
      
      acc[date].total++;
      acc[date].totalAmount = acc[date].totalAmount.plus(intervention.originalAmount);
      
      if (intervention.decision === 'DECLINED') {
        acc[date].declined++;
        acc[date].savedAmount = acc[date].savedAmount.plus(intervention.originalAmount);
      } else if (intervention.decision === 'APPROVED') {
        acc[date].approved++;
      }
      
      acc[date].totalSetback = acc[date].totalSetback.plus(intervention.setbackDays);
      
      return acc;
    }, {});

    const timeline = Object.values(grouped).map((day: any) => ({
      ...day,
      totalAmount: day.totalAmount.toString(),
      savedAmount: day.savedAmount.toString(),
      totalSetback: day.totalSetback.toFixed(2),
    }));

    res.json({
      success: true,
      data: timeline,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
