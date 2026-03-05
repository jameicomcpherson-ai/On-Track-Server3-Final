// On Track - TypeScript Type Definitions
// Application-layer types extending Prisma schema

import { Decimal } from '@prisma/client/runtime/library';

// ============================================
// JWT AUTHENTICATION TYPES
// ============================================

export interface JwtPayload {
  id: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface LoginRequest {
  email: string;
  password: string;
  mfaCode?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    nickname: string | null;
    mfaEnabled: boolean;
  };
  mfaRequired: boolean;
}

// ============================================
// CORE FOUR CALCULATION TYPES
// ============================================

export interface CoreFourBreakdown {
  netIncome: Decimal;
  fundamentalExpenses: Decimal;
  automatedSavings: Decimal;
  funSpending: Decimal;
}

export interface MonthlyFinancialSnapshot {
  userId: string;
  month: number;
  year: number;
  coreFour: CoreFourBreakdown;
  totalLiabilities: Decimal;
  weightedAvgApr: Decimal;
  estimatedFreedomDate: Date;
  daysToFreedom: number;
}

// ============================================
// THE "8% ENGINE" TYPES
// ============================================

export interface HighPriorityTarget {
  liability: Liability;
  rank: number;
  monthlyInterestAccrual: Decimal;
  estimatedPayoffMonths: number;
  totalInterestIfMinPayments: Decimal;
  totalInterestIfAccelerated: Decimal;
  interestSavings: Decimal;
}

export interface EightPercentAnalysis {
  userId: string;
  highPriorityTargets: HighPriorityTarget[];
  totalHighPriorityDebt: Decimal;
  weightedAvgHighPriorityApr: Decimal;
  recommendedMonthlyPayment: Decimal;
  projectedPayoffDate: Date;
  totalInterestSavings: Decimal;
}

// ============================================
// SETBACK DAYS CALCULATION TYPES
// ============================================

export interface SetbackCalculationInput {
  purchaseAmount: Decimal;
  userDisposableIncome: Decimal;
  targetLiabilityApr: Decimal;
  targetLiabilityBalance: Decimal;
  currentFreedomDate: Date;
}

export interface SetbackCalculationResult {
  setbackDays: Decimal;
  freedomDateImpact: Decimal;
  interestAccruedDuringSetback: Decimal;
  opportunityCost: Decimal;
  recommendedAction: 'DECLINE' | 'APPROVE_WITH_WARNING' | 'APPROVE';
  warningMessage?: string;
}

// ============================================
// INTERVENTION (QUICK DRAW) TYPES
// ============================================

export interface InterventionTrigger {
  userId: string;
  lithicTransactionToken: string;
  amount: Decimal;
  merchantName: string;
  merchantCategory: string;
  timestamp: Date;
}

export interface InterventionResponse {
  interventionId: string;
  decision: InterventionDecision;
  setbackData: SetbackCalculationResult;
  targetLiability?: Liability;
}

export interface SweepResult {
  success: boolean;
  vopayTransactionId?: string;
  amount?: Decimal;
  errorMessage?: string;
}

// ============================================
// PLAID INTEGRATION TYPES
// ============================================

export interface PlaidLinkTokenRequest {
  userId: string;
  clientName: string;
  products: string[];
  countryCodes: string[];
  language: string;
}

export interface PlaidLinkTokenResponse {
  linkToken: string;
  expiration: string;
}

export interface PlaidExchangeResponse {
  accessToken: string;
  itemId: string;
}

export interface PlaidLiabilitiesResponse {
  liabilities: {
    credit: PlaidCreditLiability[];
    student: PlaidStudentLiability[];
    mortgage: PlaidMortgageLiability[];
  };
}

export interface PlaidCreditLiability {
  accountId: string;
  apr: number;
  balance: number;
  lastPaymentAmount: number;
  lastPaymentDate: string;
  lastStatementBalance: number;
  lastStatementIssueDate: string;
  minimumPaymentAmount: number;
  nextPaymentDueDate: string;
}

export interface PlaidStudentLiability {
  accountId: string;
  accountNumber: string;
  disbursementDates: string[];
  expectedPayoffDate: string;
  guarantor: string;
  interestRatePercentage: number;
  lastPaymentAmount: number;
  lastPaymentDate: string;
  lastStatementBalance: number;
  lastStatementIssueDate: string;
  loanName: string;
  loanStatus: {
    endDate: string;
    type: string;
  };
  minimumPaymentAmount: number;
  nextPaymentDueDate: string;
  originationDate: string;
  originationPrincipalAmount: number;
  outstandingInterestAmount: number;
  paymentReferenceNumber: string;
  pslfStatus: {
    estimatedQualificationDate: string;
    paymentsMade: number;
    paymentsRemaining: number;
  };
  repaymentPlan: {
    description: string;
    type: string;
  };
  sequenceNumber: string;
  servicerAddress: {
    city: string;
    country: string;
    postalCode: string;
    region: string;
    street: string;
  };
  ytdInterestPaid: number;
  ytdPrincipalPaid: number;
}

export interface PlaidMortgageLiability {
  accountId: string;
  accountNumber: string;
  currentLateFee: number;
  escrowBalance: number;
  hasPmi: boolean;
  hasPrepaymentPenalty: boolean;
  interestRate: {
    percentage: number;
    type: string;
  };
  lastPaymentAmount: number;
  lastPaymentDate: string;
  loanTerm: string;
  loanTypeDescription: string;
  maturityDate: string;
  nextMonthlyPayment: number;
  nextPaymentDueDate: string;
  originationDate: string;
  originationPrincipalAmount: number;
  pastDueAmount: number;
  propertyAddress: {
    city: string;
    country: string;
    postalCode: string;
    region: string;
    street: string;
  };
  ytdInterestPaid: number;
  ytdPrincipalPaid: number;
}

// ============================================
// LITHIC INTEGRATION TYPES
// ============================================

export interface LithicCardRequest {
  type: 'SINGLE_USE' | 'MERCHANT_LOCKED' | 'UNLOCKED';
  memo?: string;
  spendLimit?: number;
  spendLimitDuration?: 'TRANSACTION' | 'MONTHLY' | 'ANNUALLY' | 'FOREVER';
  state?: 'OPEN' | 'PAUSED' | 'CLOSED';
}

export interface LithicCardResponse {
  token: string;
  lastFour: string;
  spendLimit: number;
  spendLimitDuration: string;
  state: string;
  type: string;
}

export interface LithicAuthorizationEvent {
  token: string;
  cardToken: string;
  amount: number;
  currency: string;
  merchant: {
    descriptor: string;
    city: string;
    country: string;
    mcc: string;
  };
  status: 'PENDING' | 'DECLINED' | 'APPROVED';
  created: string;
}

export interface LithicDeclineRequest {
  transactionToken: string;
  reason: 'CARD_PAUSED' | 'CARD_CLOSED' | 'SINGLE_USE_RECHARGED' | 'CUSTOM';
  customMessage?: string;
}

// ============================================
// VOPAY INTEGRATION TYPES
// ============================================

export interface VoPayPaymentRequest {
  amount: number;
  currency: string;
  sourceFundingSourceId: string;
  destinationFundingSourceId: string;
  description: string;
  metadata?: Record<string, string>;
}

export interface VoPayPaymentResponse {
  transactionId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  amount: number;
  createdAt: string;
}

// ============================================
// API RESPONSE TYPES
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================
// AUDIT LOGGING TYPES
// ============================================

export interface AuditLogEntry {
  userId: string;
  eventType: AuditEventType;
  eventDescription: string;
  ipAddress?: string;
  userAgent?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  success: boolean;
  failureReason?: string;
}

// ============================================
// DEBT PAYOFF SIMULATION TYPES
// ============================================

export interface PayoffSimulationInput {
  liabilities: Liability[];
  monthlyPaymentAmount: Decimal;
  strategy: 'AVALANCHE' | 'SNOWBALL' | 'HYBRID';
}

export interface PayoffSimulationResult {
  totalMonths: number;
  totalInterestPaid: Decimal;
  payoffDate: Date;
  debtSchedule: DebtPayoffScheduleItem[];
}

export interface DebtPayoffScheduleItem {
  liabilityId: string;
  name: string;
  payoffMonth: number;
  payoffDate: Date;
  totalInterestPaid: Decimal;
  payments: MonthlyPayment[];
}

export interface MonthlyPayment {
  month: number;
  paymentAmount: Decimal;
  principalPaid: Decimal;
  interestPaid: Decimal;
  remainingBalance: Decimal;
}

// ============================================
// DATABASE MODEL TYPES (Local definitions)
// ============================================

export type User = {
  id: string;
  email: string;
  nickname: string | null;
  monthlyNetIncome: Decimal;
  fundamentalExpenses: Decimal;
  automatedSavings: Decimal;
  disposableIncome: Decimal;
  freedomDate: Date | null;
  plaidAccessToken: string | null;
  plaidItemId: string | null;
  plaidAccountId: string | null;
  lithicCardToken: string | null;
  lithicAccountToken: string | null;
  vopayCustomerId: string | null;
  vopayFundingSourceId: string | null;
  passwordHash: string;
  mfaSecret: string | null;
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
};

export type Liability = {
  id: string;
  userId: string;
  creditorName: string;
  creditorType: CreditorType;
  currentBalance: Decimal;
  originalBalance: Decimal;
  apr: Decimal;
  minimumPayment: Decimal;
  isHighPriority: boolean;
  priorityRank: number | null;
  estimatedPayoffDate: Date | null;
  totalInterestPaid: Decimal;
  status: LiabilityStatus;
  capturedAt: Date | null;
  plaidAccountId: string | null;
  plaidLiabilityId: string | null;
  nickname: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Intervention = {
  id: string;
  userId: string;
  originalAmount: Decimal;
  merchantName: string;
  merchantCategory: string | null;
  decision: InterventionDecision;
  decisionReason: string | null;
  setbackDays: Decimal;
  freedomDateImpact: Decimal;
  targetLiabilityId: string | null;
  lithicTransactionToken: string | null;
  lithicDeclinedAt: Date | null;
  vopayTransactionId: string | null;
  sweptAmount: Decimal | null;
  sweptAt: Date | null;
  userRespondedAt: Date | null;
  userResponseTimeMs: number | null;
  createdAt: Date;
};

export type Payment = {
  id: string;
  liabilityId: string;
  amount: Decimal;
  principalAmount: Decimal;
  interestAmount: Decimal;
  source: PaymentSource;
  sourceReference: string | null;
  status: PaymentStatus;
  processedAt: Date | null;
  failedReason: string | null;
  vopayTransactionId: string | null;
  createdAt: Date;
};

export type Transaction = {
  id: string;
  userId: string;
  plaidTransactionId: string;
  accountId: string;
  amount: Decimal;
  currency: string;
  date: Date;
  name: string;
  merchantName: string | null;
  category: string[];
  classification: TransactionClassification | null;
  isRecurring: boolean;
  city: string | null;
  region: string | null;
  country: string | null;
  pending: boolean;
  paymentChannel: string | null;
  createdAt: Date;
};

export type AuditLog = {
  id: string;
  userId: string;
  eventType: AuditEventType;
  eventDescription: string;
  ipAddress: string | null;
  userAgent: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  success: boolean;
  failureReason: string | null;
  createdAt: Date;
};

// Enums
export type CreditorType = 
  | 'CREDIT_CARD' 
  | 'STUDENT_LOAN' 
  | 'AUTO_LOAN' 
  | 'PERSONAL_LOAN' 
  | 'MORTGAGE' 
  | 'COLLECTIONS' 
  | 'OTHER';

export type LiabilityStatus = 'ACTIVE' | 'CAPTURED' | 'PAID_OFF' | 'ERROR';

export type InterventionDecision = 'APPROVED' | 'DECLINED' | 'PENDING' | 'EXPIRED';

export type PaymentSource = 'INTERVENTION_SWEEP' | 'SCHEDULED' | 'MANUAL' | 'ROUND_UP';

export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type TransactionClassification = 
  | 'INCOME' 
  | 'FUNDAMENTAL_EXPENSE' 
  | 'AUTOMATED_SAVINGS' 
  | 'FUN_SPENDING' 
  | 'DEBT_PAYMENT' 
  | 'INVESTMENT' 
  | 'TRANSFER' 
  | 'UNKNOWN';

export type AuditEventType = 
  | 'USER_LOGIN'
  | 'USER_LOGOUT'
  | 'USER_REGISTERED'
  | 'MFA_ENABLED'
  | 'MFA_DISABLED'
  | 'PLAID_LINKED'
  | 'LITHIC_CARD_CREATED'
  | 'INTERVENTION_TRIGGERED'
  | 'INTERVENTION_DECISION'
  | 'PAYMENT_INITIATED'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_FAILED'
  | 'LIABILITY_ADDED'
  | 'LIABILITY_UPDATED'
  | 'LIABILITY_CAPTURED'
  | 'SETTINGS_CHANGED'
  | 'DATA_EXPORTED'
  | 'ADMIN_ACCESS';
