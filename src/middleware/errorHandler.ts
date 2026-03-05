// On Track - Global Error Handler
// Centralized error handling with SOC2-compliant logging

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../server';

/**
 * Custom API Error class
 */
export class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: Record<string, string[]>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, string[]>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.name = 'ApiError';
  }
}

/**
 * Global error handler middleware
 */
export async function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  console.error('Error:', err);

  // Default error response
  let statusCode = 500;
  let errorCode = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details: Record<string, string[]> | undefined;

  // Handle custom API errors
  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    errorCode = err.code;
    message = err.message;
    details = err.details;
  }
  // Handle Prisma errors (check by name and code properties)
  else if (err.name === 'PrismaClientKnownRequestError') {
    const prismaError = err as unknown as { code: string };
    switch (prismaError.code) {
      case 'P2002':
        statusCode = 409;
        errorCode = 'DUPLICATE_ENTRY';
        message = 'A record with this information already exists';
        break;
      case 'P2025':
        statusCode = 404;
        errorCode = 'NOT_FOUND';
        message = 'Record not found';
        break;
      case 'P2003':
        statusCode = 400;
        errorCode = 'FOREIGN_KEY_CONSTRAINT';
        message = 'Invalid reference to related record';
        break;
      default:
        statusCode = 500;
        errorCode = 'DATABASE_ERROR';
        message = 'Database operation failed';
    }
  }
  // Handle Prisma validation errors
  else if (err.name === 'PrismaClientValidationError') {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'Invalid data provided';
  }
  // Handle JWT errors
  else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    errorCode = 'INVALID_TOKEN';
    message = 'Invalid authentication token';
  }
  // Handle validation errors (from express-validator or similar)
  else if (err.name === 'ValidationError') {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = err.message;
  }

  // Log error to audit log for sensitive operations
  if (req.user && req.user.id && statusCode >= 400) {
    try {
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          eventType: 'ADMIN_ACCESS',
          eventDescription: `Error: ${errorCode} - ${message}`,
          success: false,
          failureReason: err.message,
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        },
      });
    } catch (logError) {
      console.error('Failed to log error to audit log:', logError);
    }
  }

  // Send error response
  res.status(statusCode).json({
    success: false,
    error: {
      code: errorCode,
      message,
      details,
    },
  });
}

/**
 * Async handler wrapper for route handlers
 * Catches errors from async functions and passes them to error handler
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
