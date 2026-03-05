// On Track - Setback Days Calculator
// The mathematical engine behind the "Quick Draw" intervention system

import { Decimal } from '@prisma/client/runtime/library';
import { SetbackCalculationResult } from '../types';

// ============================================
// CONSTANTS
// ============================================

// Average days in a month for calculations
const DAYS_PER_MONTH = new Decimal(30.44);

// Threshold for auto-decline (setback days)
const AUTO_DECLINE_THRESHOLD = new Decimal(7); // 7 days

// Threshold for warning (setback days)
const WARNING_THRESHOLD = new Decimal(3); // 3 days

// ============================================
// MAIN CALCULATION FUNCTION
// ============================================

/**
 * Calculate the "Setback Days" for a potential purchase
 * 
 * Formula: Setback Days = Purchase Amount / (Disposable Income / 30.44)
 * 
 * This tells the user: "This purchase will delay your debt freedom by X days"
 * 
 * @param params - Calculation parameters
 * @returns SetbackCalculationResult with days and recommendation
 */
export function calculateInterventionSetback(params: {
  purchaseAmount: Decimal;
  user: {
    disposableIncome: Decimal;
    freedomDate: Date;
  };
  highestPriorityLiability: {
    id: string;
    creditorName: string;
    apr: Decimal;
    currentBalance: Decimal;
  } | null;
}): SetbackCalculationResult {
  const { purchaseAmount, user, highestPriorityLiability } = params;

  // Calculate daily disposable income
  const dailyDisposableIncome = user.disposableIncome.dividedBy(DAYS_PER_MONTH);

  // Handle edge case: no disposable income
  if (dailyDisposableIncome.lessThanOrEqualTo(0)) {
    return {
      setbackDays: new Decimal(999), // Effectively infinite
      freedomDateImpact: new Decimal(999),
      interestAccruedDuringSetback: new Decimal(0),
      opportunityCost: new Decimal(0),
      recommendedAction: 'DECLINE',
      warningMessage: 'You have no disposable income. This purchase will significantly delay your debt freedom.',
    };
  }

  // Calculate setback days
  const setbackDays = purchaseAmount.dividedBy(dailyDisposableIncome);

  // Calculate interest that would accrue during the setback period
  let interestAccruedDuringSetback = new Decimal(0);
  if (highestPriorityLiability) {
    const dailyInterestRate = highestPriorityLiability.apr.dividedBy(100).dividedBy(365);
    interestAccruedDuringSetback = highestPriorityLiability.currentBalance
      .times(dailyInterestRate)
      .times(setbackDays);
  }

  // Calculate opportunity cost (what the money could earn if invested at 7% annually)
  const dailyInvestmentReturn = new Decimal(0.07).dividedBy(365); // 7% annual return
  const opportunityCost = purchaseAmount.times(dailyInvestmentReturn).times(setbackDays);

  // Calculate impact on freedom date
  const freedomDateImpact = setbackDays;

  // Determine recommended action
  let recommendedAction: 'DECLINE' | 'APPROVE_WITH_WARNING' | 'APPROVE' = 'APPROVE';
  let warningMessage: string | undefined;

  if (setbackDays.greaterThanOrEqualTo(AUTO_DECLINE_THRESHOLD)) {
    recommendedAction = 'DECLINE';
    warningMessage = `This purchase will delay your debt freedom by ${setbackDays.toFixed(1)} days. ` +
      `That's ${setbackDays.dividedBy(30).toFixed(1)} months! ` +
      `Instead, redirecting $${purchaseAmount.toFixed(2)} to your highest priority debt ` +
      `(${highestPriorityLiability?.creditorName || 'debt'}) could save you ` +
      `$${interestAccruedDuringSetback.toFixed(2)} in interest.`;
  } else if (setbackDays.greaterThanOrEqualTo(WARNING_THRESHOLD)) {
    recommendedAction = 'APPROVE_WITH_WARNING';
    warningMessage = `This purchase will delay your debt freedom by ${setbackDays.toFixed(1)} days. ` +
      `Consider if it's worth it!`;
  }

  return {
    setbackDays,
    freedomDateImpact,
    interestAccruedDuringSetback,
    opportunityCost,
    recommendedAction,
    warningMessage,
  };
}

// ============================================
// ALTERNATIVE CALCULATION METHODS
// ============================================

/**
 * Calculate setback using the original formula from the specification
 * Setback Days = Purchase Amount / (Disposable Income / 30.44)
 */
export function calculateSetbackDaysOriginal(
  purchaseAmount: Decimal,
  monthlyDisposableIncome: Decimal
): Decimal {
  const dailyDisposableIncome = monthlyDisposableIncome.dividedBy(DAYS_PER_MONTH);
  return purchaseAmount.dividedBy(dailyDisposableIncome);
}

/**
 * Calculate the "true cost" of a purchase including opportunity cost
 * This shows what the money could do if directed toward debt instead
 */
export function calculateTrueCost(params: {
  purchaseAmount: Decimal;
  highestPriorityDebtApr: Decimal;
  monthsUntilPayoff: number;
}): Decimal {
  const { purchaseAmount, highestPriorityDebtApr, monthsUntilPayoff } = params;

  // Simple interest that would be saved
  const monthlyInterestRate = highestPriorityDebtApr.dividedBy(100).dividedBy(12);
  const interestSaved = purchaseAmount
    .times(monthlyInterestRate)
    .times(new Decimal(monthsUntilPayoff));

  return purchaseAmount.plus(interestSaved);
}

// ============================================
// FORMATTING HELPERS
// ============================================

/**
 * Format setback days into a human-readable message
 */
export function formatSetbackMessage(setbackDays: Decimal): string {
  if (setbackDays.lessThan(1)) {
    const hours = setbackDays.times(24).toFixed(0);
    return `${hours} hours`;
  } else if (setbackDays.lessThan(30)) {
    return `${setbackDays.toFixed(1)} days`;
  } else {
    const months = setbackDays.dividedBy(30).toFixed(1);
    return `${months} months`;
  }
}

/**
 * Get a motivational message based on the setback
 */
export function getMotivationalMessage(setbackDays: Decimal): string {
  if (setbackDays.greaterThanOrEqualTo(30)) {
    return "That's more than a month added to your debt journey! 💪 Consider redirecting this to your highest priority target.";
  } else if (setbackDays.greaterThanOrEqualTo(7)) {
    return "That's a full week! Imagine being debt-free a week sooner. 🎯";
  } else if (setbackDays.greaterThanOrEqualTo(3)) {
    return "Every day counts on your journey to financial freedom! 🚀";
  } else {
    return "Small setbacks add up. Stay focused on your goals! ⭐";
  }
}
