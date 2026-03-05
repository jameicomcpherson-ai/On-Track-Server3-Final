// On Track - User Routes
// User profile and financial data management

import { Router, Request, Response, NextFunction } from 'express';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../server';
import { ApiError } from '../middleware/errorHandler';

const router = Router();

// ============================================
// GET CURRENT USER
// ============================================

router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        nickname: true,
        monthlyNetIncome: true,
        fundamentalExpenses: true,
        automatedSavings: true,
        disposableIncome: true,
        freedomDate: true,
        plaidItemId: true,
        lithicCardToken: true,
        mfaEnabled: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    if (!user) {
      throw new ApiError(404, 'NOT_FOUND', 'User not found');
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// UPDATE USER PROFILE
// ============================================

router.put('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { nickname, monthlyNetIncome, fundamentalExpenses, automatedSavings } = req.body;

    // Build update data
    const data: any = {};
    if (nickname !== undefined) data.nickname = nickname;
    if (monthlyNetIncome !== undefined) {
      data.monthlyNetIncome = new Decimal(monthlyNetIncome);
    }
    if (fundamentalExpenses !== undefined) {
      data.fundamentalExpenses = new Decimal(fundamentalExpenses);
    }
    if (automatedSavings !== undefined) {
      data.automatedSavings = new Decimal(automatedSavings);
    }

    // Recalculate disposable income if financial data changed
    if (monthlyNetIncome !== undefined || fundamentalExpenses !== undefined || automatedSavings !== undefined) {
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          monthlyNetIncome: true,
          fundamentalExpenses: true,
          automatedSavings: true,
        },
      });

      const income = data.monthlyNetIncome || current?.monthlyNetIncome || new Decimal(0);
      const expenses = data.fundamentalExpenses || current?.fundamentalExpenses || new Decimal(0);
      const savings = data.automatedSavings || current?.automatedSavings || new Decimal(0);

      data.disposableIncome = income.minus(expenses).minus(savings);
    }

    // Update user
    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        nickname: true,
        monthlyNetIncome: true,
        fundamentalExpenses: true,
        automatedSavings: true,
        disposableIncome: true,
        freedomDate: true,
        updatedAt: true,
      },
    });

    // Log settings change
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'SETTINGS_CHANGED',
        eventDescription: 'User profile updated',
        success: true,
      },
    });

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET FINANCIAL PROFILE
// ============================================

router.get('/me/financial-profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        liabilities: {
          where: { status: 'ACTIVE' },
          orderBy: { apr: 'desc' },
        },
        _count: {
          select: {
            liabilities: true,
            interventions: true,
          },
        },
      },
    });

    if (!user) {
      throw new ApiError(404, 'NOT_FOUND', 'User not found');
    }

    // Calculate Core Four breakdown
    const coreFour = {
      netIncome: user.monthlyNetIncome,
      fundamentalExpenses: user.fundamentalExpenses,
      automatedSavings: user.automatedSavings,
      funSpending: user.disposableIncome,
    };

    // Calculate debt summary
    const totalDebt = user.liabilities.reduce(
      (sum: Decimal, l: any) => sum.plus(l.currentBalance),
      new Decimal(0)
    );

    const totalMinimumPayment = user.liabilities.reduce(
      (sum: Decimal, l: any) => sum.plus(l.minimumPayment),
      new Decimal(0)
    );

    const highPriorityCount = user.liabilities.filter((l: any) => l.isHighPriority).length;

    // Calculate debt-to-income ratio
    const debtToIncomeRatio = user.monthlyNetIncome.greaterThan(0)
      ? totalMinimumPayment.dividedBy(user.monthlyNetIncome).times(100)
      : new Decimal(0);

    res.json({
      success: true,
      data: {
        coreFour,
        debtSummary: {
          totalLiabilities: user._count.liabilities,
          totalDebt,
          totalMinimumPayment,
          highPriorityCount,
          debtToIncomeRatio: debtToIncomeRatio.toFixed(2) + '%',
        },
        topPriorityDebt: user.liabilities[0] || null,
        freedomDate: user.freedomDate,
        interventionCount: user._count.interventions,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// DELETE ACCOUNT
// ============================================

router.delete('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { password } = req.body;

    if (!password) {
      throw new ApiError(400, 'MISSING_PASSWORD', 'Password is required to delete account');
    }

    // Verify password
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user) {
      throw new ApiError(404, 'NOT_FOUND', 'User not found');
    }

    const bcrypt = await import('bcryptjs');
    const isValid = await bcrypt.compare(password, user.passwordHash);

    if (!isValid) {
      throw new ApiError(401, 'INVALID_PASSWORD', 'Invalid password');
    }

    // Delete user (cascade will handle related records)
    await prisma.user.delete({
      where: { id: userId },
    });

    res.json({
      success: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
