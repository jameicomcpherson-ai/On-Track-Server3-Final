// On Track - Plaid Integration Routes
// Bank account linking and transaction sync

import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../server';
import { ApiError } from '../middleware/errorHandler';
import { CreditorType } from '../types';

const router = Router();

// Plaid API configuration
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const PLAID_API_URL = PLAID_ENV === 'production'
  ? 'https://production.plaid.com'
  : PLAID_ENV === 'development'
  ? 'https://development.plaid.com'
  : 'https://sandbox.plaid.com';

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET = process.env.PLAID_SECRET || '';

// Plaid API client
const plaidClient = axios.create({
  baseURL: PLAID_API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ============================================
// CREATE LINK TOKEN
// ============================================

router.post('/link-token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      throw new ApiError(404, 'NOT_FOUND', 'User not found');
    }

    const response = await plaidClient.post('/link/token/create', {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      user: {
        client_user_id: userId,
        email_address: user.email,
      },
      client_name: 'On Track',
      products: ['transactions', 'liabilities'],
      country_codes: ['US'],
      language: 'en',
      webhook: `${process.env.BACKEND_URL}/api/plaid/webhooks`,
    });

    res.json({
      success: true,
      data: {
        linkToken: response.data.link_token,
        expiration: response.data.expiration,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// EXCHANGE PUBLIC TOKEN
// ============================================

router.post('/exchange-token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { publicToken } = req.body;

    if (!publicToken) {
      throw new ApiError(400, 'MISSING_TOKEN', 'Public token is required');
    }

    // Exchange token
    const response = await plaidClient.post('/item/public_token/exchange', {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      public_token: publicToken,
    });

    const { access_token, item_id } = response.data;

    // Update user with Plaid credentials
    await prisma.user.update({
      where: { id: userId },
      data: {
        plaidAccessToken: access_token,
        plaidItemId: item_id,
      },
    });

    // Log Plaid link
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'PLAID_LINKED',
        eventDescription: 'Bank account linked via Plaid',
        success: true,
      },
    });

    // Sync liabilities immediately
    await syncLiabilities(userId, access_token);

    res.json({
      success: true,
      message: 'Bank account linked successfully',
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET ACCOUNTS
// ============================================

router.get('/accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plaidAccessToken: true },
    });

    if (!user?.plaidAccessToken) {
      throw new ApiError(400, 'PLAID_NOT_LINKED', 'No bank account linked');
    }

    const response = await plaidClient.post('/accounts/get', {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      access_token: user.plaidAccessToken,
    });

    res.json({
      success: true,
      data: response.data.accounts,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET TRANSACTIONS
// ============================================

router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plaidAccessToken: true },
    });

    if (!user?.plaidAccessToken) {
      throw new ApiError(400, 'PLAID_NOT_LINKED', 'No bank account linked');
    }

    // Get last 90 days of transactions
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const response = await plaidClient.post('/transactions/get', {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      access_token: user.plaidAccessToken,
      start_date: startDate,
      end_date: endDate,
    });

    // Store transactions in database
    for (const txn of response.data.transactions) {
      await prisma.transaction.upsert({
        where: { plaidTransactionId: txn.transaction_id },
        update: {
          amount: new Decimal(Math.abs(txn.amount)),
          date: new Date(txn.date),
          name: txn.name,
          merchantName: txn.merchant_name,
          category: txn.category || [],
          pending: txn.pending,
        },
        create: {
          userId,
          plaidTransactionId: txn.transaction_id,
          accountId: txn.account_id,
          amount: new Decimal(Math.abs(txn.amount)),
          date: new Date(txn.date),
          name: txn.name,
          merchantName: txn.merchant_name,
          category: txn.category || [],
          pending: txn.pending,
        },
      });
    }

    res.json({
      success: true,
      data: response.data.transactions,
      total_transactions: response.data.total_transactions,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// GET LIABILITIES
// ============================================

router.get('/liabilities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plaidAccessToken: true },
    });

    if (!user?.plaidAccessToken) {
      throw new ApiError(400, 'PLAID_NOT_LINKED', 'No bank account linked');
    }

    const response = await plaidClient.post('/liabilities/get', {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      access_token: user.plaidAccessToken,
    });

    // Sync liabilities to database
    await syncLiabilities(userId, user.plaidAccessToken);

    res.json({
      success: true,
      data: response.data.liabilities,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SYNC DATA
// ============================================

router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plaidAccessToken: true },
    });

    if (!user?.plaidAccessToken) {
      throw new ApiError(400, 'PLAID_NOT_LINKED', 'No bank account linked');
    }

    // Sync liabilities
    await syncLiabilities(userId, user.plaidAccessToken);

    // Sync transactions
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const txnResponse = await plaidClient.post('/transactions/get', {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      access_token: user.plaidAccessToken,
      start_date: startDate,
      end_date: endDate,
    });

    // Store transactions
    for (const txn of txnResponse.data.transactions) {
      await prisma.transaction.upsert({
        where: { plaidTransactionId: txn.transaction_id },
        update: {
          amount: new Decimal(Math.abs(txn.amount)),
          date: new Date(txn.date),
          name: txn.name,
          merchantName: txn.merchant_name,
          category: txn.category || [],
          pending: txn.pending,
        },
        create: {
          userId,
          plaidTransactionId: txn.transaction_id,
          accountId: txn.account_id,
          amount: new Decimal(Math.abs(txn.amount)),
          date: new Date(txn.date),
          name: txn.name,
          merchantName: txn.merchant_name,
          category: txn.category || [],
          pending: txn.pending,
        },
      });
    }

    res.json({
      success: true,
      message: 'Data synced successfully',
      transactionsSynced: txnResponse.data.transactions.length,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// WEBHOOK HANDLER
// ============================================

router.post('/webhooks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { webhook_type, webhook_code, item_id } = req.body;

    console.log('Plaid webhook received:', { webhook_type, webhook_code, item_id });

    // Handle different webhook types
    switch (webhook_code) {
      case 'DEFAULT_UPDATE':
        // New transactions available
        // Trigger sync for this item
        break;
      case 'INITIAL_UPDATE':
        // Initial transaction data available
        break;
      case 'HISTORICAL_UPDATE':
        // Historical transaction data available
        break;
      case 'TRANSACTIONS_REMOVED':
        // Transactions removed
        break;
      case 'ITEM_LOGIN_REQUIRED':
        // User needs to re-authenticate
        break;
      case 'ERROR':
        // Error occurred
        console.error('Plaid webhook error:', req.body);
        break;
    }

    res.status(200).send('OK');
  } catch (error) {
    next(error);
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Sync liabilities from Plaid to database
 */
async function syncLiabilities(userId: string, accessToken: string): Promise<void> {
  const response = await plaidClient.post('/liabilities/get', {
    client_id: PLAID_CLIENT_ID,
    secret: PLAID_SECRET,
    access_token: accessToken,
  });

  const { liabilities } = response.data;

  // Process credit cards
  if (liabilities.credit) {
    for (const credit of liabilities.credit) {
      await upsertLiability(userId, credit, 'CREDIT_CARD');
    }
  }

  // Process student loans
  if (liabilities.student) {
    for (const student of liabilities.student) {
      await upsertLiability(userId, student, 'STUDENT_LOAN');
    }
  }

  // Process mortgages
  if (liabilities.mortgage) {
    for (const mortgage of liabilities.mortgage) {
      await upsertLiability(userId, mortgage, 'OTHER');
    }
  }
}

/**
 * Upsert a liability from Plaid data
 */
async function upsertLiability(
  userId: string,
  plaidLiability: any,
  type: CreditorType
): Promise<void> {
  const apr = plaidLiability.aprs?.[0]?.apr_percentage || 
              plaidLiability.interest_rate_percentage || 0;
  
  const isHighPriority = new Decimal(apr).greaterThan(8);

  // Use plaidLiabilityId with @unique constraint
  const plaidLiabilityId = plaidLiability.account_id;
  
  // Check if liability exists
  const existing = await prisma.liability.findUnique({
    where: { plaidLiabilityId },
  });

  if (existing) {
    // Update existing
    await prisma.liability.update({
      where: { plaidLiabilityId },
      data: {
        currentBalance: new Decimal(plaidLiability.last_statement_balance || 0),
        apr: new Decimal(apr),
        minimumPayment: new Decimal(plaidLiability.minimum_payment_amount || 0),
        isHighPriority,
      },
    });
  } else {
    // Create new
    await prisma.liability.create({
      data: {
        userId,
        creditorName: plaidLiability.name || 'Unknown Creditor',
        creditorType: type,
        currentBalance: new Decimal(plaidLiability.last_statement_balance || 0),
        originalBalance: new Decimal(plaidLiability.origination_principal_amount || plaidLiability.last_statement_balance || 0),
        apr: new Decimal(apr),
        minimumPayment: new Decimal(plaidLiability.minimum_payment_amount || 0),
        isHighPriority,
        plaidAccountId: plaidLiability.account_id,
        plaidLiabilityId: plaidLiability.account_id,
      },
    });
  }
}

export default router;
