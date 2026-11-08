import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { validateRequest } from '../middleware/validate.js';
import { generateToken, verifyToken, revokeToken, isTokenRevoked } from '../utils/token.js';
import { setAuthCookie, clearAuthCookie, AUTH_COOKIE_NAME } from '../utils/cookie.js';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { sendEmail, buildPasswordResetOtpHtml } from '../services/email/emailService.js';
import { recordActivity } from '../services/activity/activityService.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().min(1, 'Email or username is required'),
  password: z.string().min(1, 'Password is required')
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email address')
});

const verifyResetOtpSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  otp: z.string().min(4, 'OTP code is too short').max(10, 'OTP code is too long')
});

const resetPasswordSchema = z.object({
  reset_token: z.string().min(10, 'Reset token is required'),
  new_password: z.string().min(8, 'Password must be at least 8 characters long'),
  confirm_new_password: z.string().min(8, 'Password confirmation is required')
}).refine((data) => data.new_password === data.confirm_new_password, {
  message: 'Passwords do not match',
  path: ['confirm_new_password']
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: z.string().min(8, 'Password must be at least 8 characters long'),
  confirm_new_password: z.string().min(8, 'Password confirmation is required')
}).refine((data) => data.new_password === data.confirm_new_password, {
  message: 'Passwords do not match',
  path: ['confirm_new_password']
});

/**
 * POST /api/v1/auth/login
 * Authenticates either PlatformAdmin or Tenant User using database credentials.
 * Issues cryptographically signed HMAC-SHA256 JWT tokens.
 */
router.post('/login', validateRequest(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.validatedBody;
    const cleanEmail = email.trim();

    // 1. Check if user is a PlatformAdmin
    const admin = await prisma.platformAdmin.findFirst({
      where: {
        OR: [
          { email: cleanEmail },
          { username: cleanEmail }
        ]
      }
    });

    if (admin) {
      const isValid = await bcrypt.compare(password, admin.passwordHash);

      if (isValid) {
        const { token } = generateToken({
          sub: admin.id,
          role: 'platform_admin',
          email: admin.email,
          auth_key: admin.authKey,
          tenant_id: null,
          tenant_slug: null
        });

        // Set secure HttpOnly cookie for platform admin
        setAuthCookie(res, token, 'platform_admin');

        const userObj = {
          id: admin.id,
          username: admin.username,
          email: admin.email,
          fullName: admin.fullName || 'Platform Admin'
        };

        return res.status(200).json({
          status: 'success',
          token,
          role: 'platform_admin',
          user: userObj,
          data: {
            token,
            role: 'platform_admin',
            user: userObj
          }
        });
      }
    }

    // 2. Check if user is a Tenant User
    const tenantUser = await prisma.user.findFirst({
      where: {
        email: { equals: cleanEmail, mode: 'insensitive' }
      },
      include: {
        tenant: true
      }
    });

    if (tenantUser) {
      if (tenantUser.tenant?.status !== 'active') {
        return res.status(403).json({
          status: 'error',
          message: 'Tenant shop account is currently suspended or deleted.'
        });
      }

      const isValid = await bcrypt.compare(password, tenantUser.passwordHash);

      if (isValid) {
        const { token } = generateToken({
          sub: tenantUser.id,
          role: 'tenant_user',
          email: tenantUser.email,
          auth_key: tenantUser.authKey,
          tenant_id: tenantUser.tenantId,
          tenant_slug: tenantUser.tenant.slug
        });

        // Set secure HttpOnly cookie for tenant shop user
        setAuthCookie(res, token, 'tenant_user');

        const userObj = {
          id: tenantUser.id,
          email: tenantUser.email,
          fullName: tenantUser.fullName || 'Shop Staff'
        };

        const tenantObj = {
          id: tenantUser.tenant.id,
          slug: tenantUser.tenant.slug,
          name: tenantUser.tenant.name,
          business_type: tenantUser.tenant.businessType,
          businessType: tenantUser.tenant.businessType,
          status: tenantUser.tenant.status,
          max_products: tenantUser.tenant.maxProducts,
          max_bookings: tenantUser.tenant.maxBookings,
          max_sales: tenantUser.tenant.maxSales,
          maxProducts: tenantUser.tenant.maxProducts,
          maxBookings: tenantUser.tenant.maxBookings,
          maxSales: tenantUser.tenant.maxSales
        };
        userObj.tenant = tenantObj;

        recordActivity({
          tenantId: tenantUser.tenant.id,
          userId: tenantUser.id,
          userEmail: tenantUser.email,
          userName: tenantUser.fullName || 'Shop Staff',
          action: 'login',
          entityType: 'auth',
          entityId: tenantUser.id,
          summary: `Signed in successfully (${tenantUser.email})`,
          metadata: { role: 'tenant_user', tenantName: tenantUser.tenant.name },
          req
        });

        return res.status(200).json({
          status: 'success',
          token,
          role: 'tenant_user',
          user: userObj,
          tenant: tenantObj,
          data: {
            token,
            role: 'tenant_user',
            user: userObj,
            tenant: tenantObj
          }
        });
      }
    }

    // Invalid credentials
    return res.status(401).json({
      status: 'error',
      message: 'Invalid credentials. Please verify your email/username and password.'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/auth/me
 * Returns current authenticated profile using verified JWT context.
 */
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    if (req.user.role === 'platform_admin') {
      const admin = await prisma.platformAdmin.findUnique({
        where: { id: req.user.sub },
        select: {
          id: true,
          username: true,
          email: true,
          fullName: true,
          authKey: true
        }
      });

      if (!admin) {
        return res.status(401).json({ status: 'error', message: 'Admin account not found' });
      }

      return res.status(200).json({
        status: 'success',
        role: 'platform_admin',
        user: {
          id: admin.id,
          username: admin.username,
          email: admin.email,
          fullName: admin.fullName
        }
      });
    }

    if (req.user.role === 'tenant_user') {
      const user = await prisma.user.findUnique({
        where: { id: req.user.sub },
        include: {
          tenant: true
        }
      });

      if (!user) {
        return res.status(401).json({ status: 'error', message: 'User account not found' });
      }

      const tenantPayload = {
        id: user.tenant.id,
        slug: user.tenant.slug,
        name: user.tenant.name,
        business_type: user.tenant.businessType,
        businessType: user.tenant.businessType,
        status: user.tenant.status,
        max_products: user.tenant.maxProducts,
        max_bookings: user.tenant.maxBookings,
        max_sales: user.tenant.maxSales,
        maxProducts: user.tenant.maxProducts,
        maxBookings: user.tenant.maxBookings,
        maxSales: user.tenant.maxSales
      };

      return res.status(200).json({
        status: 'success',
        role: 'tenant_user',
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          tenant: tenantPayload
        },
        tenant: tenantPayload
      });
    }

    return res.status(403).json({ status: 'error', message: 'Unsupported user role' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/auth/logout
 * Server-side session invalidation and token revocation.
 */
router.post('/logout', async (req, res, next) => {
  try {
    let token = req.cookies?.[AUTH_COOKIE_NAME] || req.cookies?.token;
    if (!token && req.headers.authorization) {
      token = req.headers.authorization.replace(/^Bearer\s+/i, '').trim();
    }

    if (token) {
      try {
        const payload = verifyToken(token);
        if (payload?.jti) {
          await revokeToken(payload.jti, payload.sub, payload.exp);
        }
        if (payload?.role === 'tenant_user' && payload?.tenant_id) {
          recordActivity({
            tenantId: payload.tenant_id,
            userId: payload.sub,
            userEmail: payload.email,
            action: 'logout',
            entityType: 'auth',
            entityId: payload.sub,
            summary: `User signed out (${payload.email})`,
            req
          });
        }
      } catch {
        // Token was invalid, expired or already revoked - proceed to purge cookie
      }
    }

    clearAuthCookie(res);

    return res.status(200).json({
      status: 'success',
      message: 'Logged out and session revoked successfully'
    });
  } catch (error) {
    clearAuthCookie(res);
    next(error);
  }
});

/**
 * POST /api/v1/auth/forgot-password
 * Initiates self-service password reset.
 * Protects against account enumeration: returns identical generic response for existing and non-existing accounts.
 * Enforces a strict 2-minute (120s) cooldown before allowing OTP resend.
 */
router.post('/forgot-password', validateRequest(forgotPasswordSchema), async (req, res, next) => {
  try {
    const { email } = req.validatedBody;
    const normalizedEmail = email.trim().toLowerCase();

    // Universal generic response to defeat email/account enumeration
    const genericResponse = {
      status: 'success',
      message: 'If an account matches the information provided, you will receive an email with further instructions.',
      data: {
        otp_length: 6,
        expiry_minutes: 10,
        resend_cooldown: 120
      }
    };

    let userToEmail = null;
    let generatedOtp = null;

    try {
      await prisma.$transaction(async (tx) => {
        // Parameterized row-level lock on user record to serialize concurrent OTP bursts
        const lockedUsers = await tx.$queryRaw`
          SELECT u.id, u.email, u.tenant_id, t.status AS tenant_status
          FROM app.users u
          JOIN app.tenants t ON t.id = u.tenant_id
          WHERE LOWER(u.email) = ${normalizedEmail}
          FOR UPDATE;
        `;

        if (!lockedUsers || lockedUsers.length === 0 || lockedUsers[0].tenant_status !== 'active') {
          return;
        }

        const user = lockedUsers[0];
        const now = new Date();

        // Check recent OTP with lock to enforce 2-minute cooldown
        const recentOtps = await tx.$queryRaw`
          SELECT id, resend_after, expires_at 
          FROM app.password_reset_otps 
          WHERE user_id = ${user.id}::uuid AND used_at IS NULL
          ORDER BY created_at DESC 
          LIMIT 1
          FOR UPDATE;
        `;

        if (recentOtps && recentOtps.length > 0) {
          const recentOtp = recentOtps[0];
          const resendAfter = new Date(recentOtp.resend_after);
          if (resendAfter > now) {
            const remainingSeconds = Math.ceil((resendAfter.getTime() - now.getTime()) / 1000);
            const err = new Error(`Please wait ${remainingSeconds} seconds before requesting a new verification code.`);
            err.code = 'OTP_COOLDOWN_ACTIVE';
            err.status = 429;
            err.remainingSeconds = remainingSeconds;
            throw err;
          }
        }

        // Generate cryptographically secure 6-digit numeric OTP
        const otp = crypto.randomInt(100000, 1000000).toString();
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes validity
        const resendAfter = new Date(now.getTime() + 120 * 1000); // 2 minutes cooldown

        // Invalidate prior unused OTPs
        await tx.passwordResetOtp.updateMany({
          where: {
            userId: user.id,
            usedAt: null
          },
          data: {
            usedAt: now
          }
        });

        // Persist OTP with bcrypt hash
        await tx.passwordResetOtp.create({
          data: {
            userId: user.id,
            tenantId: user.tenant_id,
            email: normalizedEmail,
            otpHash,
            expiresAt,
            resendAfter
          }
        });

        userToEmail = {
          id: user.id,
          tenantId: user.tenant_id,
          email: user.email
        };
        generatedOtp = otp;
      });
    } catch (txErr) {
      if (txErr.status === 429) {
        return res.status(429).json({
          status: 'error',
          code: txErr.code,
          message: txErr.message,
          retry_after_seconds: txErr.remainingSeconds
        });
      }
      throw txErr;
    }

    if (!userToEmail) {
      // Artificial delay (80ms) to align response timing against enumeration
      await new Promise((resolve) => setTimeout(resolve, 80));
      return res.status(200).json(genericResponse);
    }

    // Asynchronously dispatch OTP email via SMTP
    const emailHtml = buildPasswordResetOtpHtml({ otp: generatedOtp, expiryMinutes: 10 });
    sendEmail({
      tenantId: userToEmail.tenantId,
      to: normalizedEmail,
      subject: 'KapadKart — Your Password Reset Verification Code',
      html: emailHtml,
      templateName: 'password_reset_otp',
      metadata: { user_id: userToEmail.id }
    }).catch((emailErr) => {
      console.error('[Auth] Failed to dispatch forgot-password email:', emailErr.message);
    });

    return res.status(200).json(genericResponse);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/auth/verify-reset-otp
 * Validates the 6-digit OTP against bcrypt hash and issues a single-use signed reset token.
 */
router.post('/verify-reset-otp', validateRequest(verifyResetOtpSchema), async (req, res, next) => {
  try {
    const { email, otp } = req.validatedBody;
    const normalizedEmail = email.trim().toLowerCase();

    const record = await prisma.passwordResetOtp.findFirst({
      where: {
        email: { equals: normalizedEmail, mode: 'insensitive' },
        usedAt: null
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!record) {
      return res.status(400).json({
        status: 'error',
        message: 'No active verification code found or code has expired. Please request a new code.'
      });
    }

    if (new Date() > new Date(record.expiresAt)) {
      return res.status(400).json({
        status: 'error',
        message: 'Verification code has expired. Please request a new code.'
      });
    }

    if (record.attemptCount >= record.maxAttempts) {
      return res.status(400).json({
        status: 'error',
        message: 'Maximum verification attempts exceeded. Please request a new code.'
      });
    }

    const isMatch = await bcrypt.compare(otp.trim(), record.otpHash);

    if (!isMatch) {
      await prisma.passwordResetOtp.update({
        where: { id: record.id },
        data: {
          attemptCount: { increment: 1 },
          updatedAt: new Date()
        }
      });
      return res.status(400).json({
        status: 'error',
        message: 'Invalid verification code. Please check your email and try again.'
      });
    }

    // Mark OTP as used
    await prisma.passwordResetOtp.update({
      where: { id: record.id },
      data: {
        usedAt: new Date(),
        updatedAt: new Date()
      }
    });

    // Issue single-use signed reset authorization token (expires in 15 minutes)
    const { token: resetToken } = generateToken(
      {
        sub: record.userId,
        email: normalizedEmail,
        tenant_id: record.tenantId,
        purpose: 'password_reset'
      },
      { expiresIn: '15m' }
    );

    return res.status(200).json({
      status: 'success',
      message: 'Verification code confirmed.',
      data: {
        reset_token: resetToken
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/auth/reset-password
 * Applies new password using verified single-use reset authorization token.
 * Enforces maximum 5 password changes per user per calendar day.
 */
router.post('/reset-password', validateRequest(resetPasswordSchema), async (req, res, next) => {
  try {
    const { reset_token, new_password } = req.validatedBody;

    let payload;
    try {
      payload = verifyToken(reset_token);
    } catch {
      return res.status(401).json({
        status: 'error',
        message: 'Password reset authorization token is invalid or has expired. Please start over.'
      });
    }

    if (payload.purpose !== 'password_reset') {
      return res.status(403).json({
        status: 'error',
        message: 'Invalid token purpose for password reset.'
      });
    }

    if (await isTokenRevoked(payload.jti)) {
      return res.status(401).json({
        status: 'error',
        message: 'This reset token has already been used.'
      });
    }

    const userId = payload.sub;

    try {
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId }
        });

        if (!user) {
          const err = new Error('User account not found');
          err.status = 404;
          throw err;
        }

        // Enforce daily limit: max 5 successful password changes per calendar day (UTC)
        const startOfTodayUtc = new Date();
        startOfTodayUtc.setUTCHours(0, 0, 0, 0);

        const dailyCount = await tx.passwordChangeLog.count({
          where: {
            userId,
            changedAt: { gte: startOfTodayUtc }
          }
        });

        if (dailyCount >= 5) {
          const err = new Error("You have reached today's password change limit. Please try again after the daily limit resets.");
          err.code = 'DAILY_PASSWORD_CHANGE_LIMIT_REACHED';
          err.status = 429;
          throw err;
        }

        const newHash = await bcrypt.hash(new_password, 10);

        // Update user password
        await tx.user.update({
          where: { id: userId },
          data: {
            passwordHash: newHash,
            updatedAt: new Date()
          }
        });

        // Record change log
        await tx.passwordChangeLog.create({
          data: {
            userId,
            tenantId: user.tenantId || payload.tenant_id || null,
            source: 'FORGOT_PASSWORD_RESET',
            ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
            userAgent: req.headers['user-agent'] || null
          }
        });
      });
    } catch (txErr) {
      if (txErr.status === 404) {
        return res.status(404).json({ status: 'error', message: txErr.message });
      }
      if (txErr.status === 429) {
        return res.status(429).json({
          status: 'error',
          code: txErr.code,
          message: txErr.message
        });
      }
      throw txErr;
    }

    // Revoke the reset token so it cannot be reused
    await revokeToken(payload.jti, userId, payload.exp);

    if (payload.tenant_id) {
      recordActivity({
        tenantId: payload.tenant_id,
        userId: userId,
        userEmail: payload.email,
        action: 'password_change',
        entityType: 'auth',
        entityId: userId,
        summary: `Password reset via OTP verification (${payload.email})`,
        req
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Password has been successfully reset. Please sign in with your new credentials.'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/auth/change-password
 * Authenticated password update endpoint.
 * Enforces maximum 5 password changes per user per calendar day.
 */
router.put('/change-password', authenticateToken, validateRequest(changePasswordSchema), async (req, res, next) => {
  try {
    const { current_password, new_password } = req.validatedBody;
    const userId = req.user.sub;
    const isPlatformAdmin = req.user.role === 'platform_admin';

    try {
      await prisma.$transaction(async (tx) => {
        if (isPlatformAdmin) {
          const admin = await tx.platformAdmin.findUnique({
            where: { id: userId }
          });

          if (!admin) {
            const err = new Error('Admin account not found');
            err.status = 404;
            throw err;
          }

          const isValid = await bcrypt.compare(current_password, admin.passwordHash);
          if (!isValid) {
            const err = new Error('Current password is incorrect.');
            err.status = 400;
            throw err;
          }

          const newHash = await bcrypt.hash(new_password, 10);
          await tx.platformAdmin.update({
            where: { id: userId },
            data: {
              passwordHash: newHash,
              updatedAt: new Date()
            }
          });
        } else {
          const user = await tx.user.findUnique({
            where: { id: userId }
          });

          if (!user) {
            const err = new Error('User account not found');
            err.status = 404;
            throw err;
          }

          // Check daily limit (max 5 per calendar day in UTC)
          const startOfTodayUtc = new Date();
          startOfTodayUtc.setUTCHours(0, 0, 0, 0);

          const dailyCount = await tx.passwordChangeLog.count({
            where: {
              userId,
              changedAt: { gte: startOfTodayUtc }
            }
          });

          if (dailyCount >= 5) {
            const err = new Error("You have reached today's password change limit. Please try again after the daily limit resets.");
            err.code = 'DAILY_PASSWORD_CHANGE_LIMIT_REACHED';
            err.status = 429;
            throw err;
          }

          const isValid = await bcrypt.compare(current_password, user.passwordHash);
          if (!isValid) {
            const err = new Error('Current password is incorrect.');
            err.status = 400;
            throw err;
          }

          const newHash = await bcrypt.hash(new_password, 10);
          await tx.user.update({
            where: { id: userId },
            data: {
              passwordHash: newHash,
              updatedAt: new Date()
            }
          });

          await tx.passwordChangeLog.create({
            data: {
              userId,
              tenantId: user.tenantId,
              source: 'CHANGE_PASSWORD',
              ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
              userAgent: req.headers['user-agent'] || null
            }
          });
        }
      });
    } catch (txErr) {
      if (txErr.status === 404) {
        return res.status(404).json({ status: 'error', message: txErr.message });
      }
      if (txErr.status === 400) {
        return res.status(400).json({ status: 'error', message: txErr.message });
      }
      if (txErr.status === 429) {
        return res.status(429).json({
          status: 'error',
          code: txErr.code,
          message: txErr.message
        });
      }
      throw txErr;
    }

    // Revoke current session so user signs in again with new password
    if (req.jti) {
      await revokeToken(req.jti, userId, req.user.exp);
    }
    clearAuthCookie(res);

    if (req.user?.role === 'tenant_user' && req.user?.tenant_id) {
      recordActivity({
        tenantId: req.user.tenant_id,
        userId: userId,
        userEmail: req.user.email,
        action: 'password_change',
        entityType: 'auth',
        entityId: userId,
        summary: `Password changed successfully (${req.user.email})`,
        req
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Password changed successfully. Please sign in again.'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
