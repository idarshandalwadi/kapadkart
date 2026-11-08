import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * 404 handler for unknown routes.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    status: 'error',
    message: `Resource not found: ${req.method} ${req.originalUrl}`
  });
}

/**
 * Centralized error handler.
 * Prevents stack trace and internal error disclosure in production.
 */
export function errorHandler(err, req, res, _next) { // eslint-disable-line no-unused-vars
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      status: 'error',
      success: false,
      code: 'LIMIT_FILE_SIZE',
      message: 'Image size exceeds the maximum limit of 10MB. Please upload an image under 10MB.'
    });
  }

  // Intercept Prisma Client Known Request Errors
  if (err.code === 'P2002') {
    const target = Array.isArray(err.meta?.target)
      ? err.meta.target.join(',')
      : String(err.meta?.target || '');
    const errMessage = String(err.message || '');

    // 1. Tenant + Product Code duplicate
    if (
      target.includes('product_code') ||
      target.includes('products_tenant_id_product_code_key') ||
      /product.*code/i.test(errMessage)
    ) {
      return res.status(409).json({
        status: 'error',
        success: false,
        code: 'DUPLICATE_PRODUCT_CODE',
        message: 'Product code already exists in your shop. Please enter a different product code.',
        fieldErrors: {
          product_code: 'Product code already exists in your shop. Please enter a different product code.'
        }
      });
    }

    // 2. Tenant Slug duplicate
    if (
      target.includes('slug') ||
      target.includes('tenants_slug_key') ||
      /slug/i.test(errMessage)
    ) {
      return res.status(409).json({
        status: 'error',
        success: false,
        code: 'DUPLICATE_SLUG',
        message: 'This shop URL slug is already taken. Please enter a different slug.',
        fieldErrors: {
          slug: 'This shop URL slug is already taken. Please enter a different slug.'
        }
      });
    }

    // 3. User email duplicate
    if (
      target.includes('email') ||
      target.includes('users_tenant_id_email_key') ||
      /email/i.test(errMessage)
    ) {
      return res.status(409).json({
        status: 'error',
        success: false,
        code: 'DUPLICATE_EMAIL',
        message: 'This email address is already registered.',
        fieldErrors: {
          email: 'This email address is already registered.'
        }
      });
    }

    // 4. Category/Brand duplicate
    if (
      target.includes('name') ||
      target.includes('brands_tenant_id_name_key') ||
      target.includes('categories_tenant_id_name_key')
    ) {
      return res.status(409).json({
        status: 'error',
        success: false,
        code: 'DUPLICATE_NAME',
        message: 'An item with this name already exists in your shop.',
        fieldErrors: {
          name: 'An item with this name already exists in your shop.'
        }
      });
    }

    // Fallback conflict
    return res.status(409).json({
      status: 'error',
      success: false,
      code: 'CONFLICT',
      message: 'A record with this identifier already exists.'
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      status: 'error',
      success: false,
      code: 'NOT_FOUND',
      message: 'The requested record was not found.'
    });
  }

  const rawStatus = err.status || err.statusCode;
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 ? rawStatus : 500;

  logger.error('Unhandled error occurred', {
    error: err.message,
    status,
    url: req.originalUrl,
    method: req.method,
    stack: env.NODE_ENV === 'development' ? err.stack : undefined
  });

  const response = {
    status: 'error',
    success: false,
    code: err.code || (status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'),
    message: status === 500 && env.NODE_ENV === 'production'
      ? 'An unexpected internal error occurred.'
      : err.message || 'Internal Server Error'
  };

  if (err.fieldErrors) {
    response.fieldErrors = err.fieldErrors;
  }

  // Include validation details if error is a ZodError or has details
  if (err.errors || err.details) {
    response.details = err.errors || err.details;
  }

  // Include stack trace only in development
  if (env.NODE_ENV === 'development' && err.stack) {
    response.stack = err.stack;
  }

  res.status(status).json(response);
}
