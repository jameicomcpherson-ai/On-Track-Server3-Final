// On Track - Authentication Routes
// JWT-based auth with MFA support

import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { prisma } from '../server';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { Decimal } from '@prisma/client/runtime/library';

const router = Router();
const SALT_ROUNDS = 12;

// ============================================
// REGISTRATION
// ============================================

router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, nickname, monthlyNetIncome, fundamentalExpenses } = req.body;

    if (!email || !password) {
      throw new ApiError(400, 'MISSING_FIELDS', 'Email and password are required');
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ApiError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const disposableIncome = monthlyNetIncome && fundamentalExpenses
      ? new Decimal(monthlyNetIncome).minus(new Decimal(fundamentalExpenses))
      : new Decimal(0);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        nickname,
        monthlyNetIncome: monthlyNetIncome ? new Decimal(monthlyNetIncome) : new Decimal(0),
        fundamentalExpenses: fundamentalExpenses ? new Decimal(fundamentalExpenses) : new Decimal(0),
        disposableIncome,
      },
      select: {
        id: true,
        email: true,
        nickname: true,
        createdAt: true,
      },
    });

    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
    });
    const refreshToken = generateRefreshToken(user.id);

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        eventType: 'USER_REGISTERED',
        eventDescription: 'User registered successfully',
        success: true,
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        user,
        accessToken,
        refreshToken,
        mfaRequired: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// LOGIN
// ============================================

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, mfaCode } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (user.mfaEnabled) {
      if (!mfaCode) {
        res.json({
          success: true,
          mfaRequired: true,
          message: 'MFA code required',
        });
        return;
      }

      const isMfaValid = speakeasy.totp.verify({
        secret: user.mfaSecret || '',
        encoding: 'base32',
        token: mfaCode,
        window: 1,
      });

      if (!isMfaValid) {
        throw new ApiError(401, 'INVALID_MFA', 'Invalid MFA code');
      }
    }

    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
    });
    const refreshToken = generateRefreshToken(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        eventType: 'USER_LOGIN',
        eventDescription: 'User logged in successfully',
        success: true,
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      },
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          mfaEnabled: user.mfaEnabled,
        },
        accessToken,
        refreshToken,
        mfaRequired: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// TOKEN REFRESH
// ============================================

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new ApiError(401, 'MISSING_TOKEN', 'Refresh token is required');
    }

    const decoded = verifyRefreshToken(refreshToken);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user) {
      throw new ApiError(401, 'INVALID_TOKEN', 'Invalid refresh token');
    }

    const newAccessToken = generateAccessToken({
      id: user.id,
      email: user.email,
    });
    const newRefreshToken = generateRefreshToken(user.id);

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// MFA SETUP
// ============================================

router.post('/mfa/setup', async (req: Request, res: Response, next: NextFunction) => {
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

    const secret = speakeasy.generateSecret({
      name: `On Track:${user.email}`,
      length: 32,
    });

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url || '');

    await prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: secret.base32 },
    });

    res.json({
      success: true,
      data: {
        secret: secret.base32,
        qrCode: qrCodeUrl,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// MFA VERIFY
// ============================================

router.post('/mfa/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { code } = req.body;

    if (!code) {
      throw new ApiError(400, 'MISSING_CODE', 'MFA code is required');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecret: true },
    });

    if (!user?.mfaSecret) {
      throw new ApiError(400, 'MFA_NOT_SETUP', 'MFA not set up');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isValid) {
      throw new ApiError(400, 'INVALID_CODE', 'Invalid MFA code');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'MFA_ENABLED',
        eventDescription: 'MFA enabled successfully',
        success: true,
      },
    });

    res.json({
      success: true,
      message: 'MFA enabled successfully',
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// MFA DISABLE
// ============================================

router.post('/mfa/disable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'User not authenticated');
    }

    const { code } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecret: true, mfaEnabled: true },
    });

    if (!user?.mfaEnabled) {
      throw new ApiError(400, 'MFA_NOT_ENABLED', 'MFA is not enabled');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.mfaSecret || '',
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isValid) {
      throw new ApiError(400, 'INVALID_CODE', 'Invalid MFA code');
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'MFA_DISABLED',
        eventDescription: 'MFA disabled',
        success: true,
      },
    });

    res.json({
      success: true,
      message: 'MFA disabled successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
