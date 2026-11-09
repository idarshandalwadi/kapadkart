import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { resolveShopAppUrl, shopEmailLinks } from './appLinks.js';

/**
 * Shop-app links for an email. Local API requests keep localhost.
 * Requests that reach the public API use the live shop app.
 */
export function emailLinksForRequest(req) {
  const forwarded = req?.get?.('x-forwarded-host') || '';
  const host = req?.get?.('host') || '';
  const base = resolveShopAppUrl({
    nodeEnv: env.NODE_ENV,
    configured: env.SHOP_APP_URL,
    requestHost: [forwarded, host].filter(Boolean).join(',')
  });
  return shopEmailLinks(base);
}

let transporter = null;

const SMTP_VERIFY_TIMEOUT_MS = 10000;
const SMTP_HEALTH_CACHE_MS = 20000;
let cachedSmtpCheck = null;
let cachedSmtpCheckedAt = 0;

export function smtpProviderLabel(host) {
  const value = String(host || '').toLowerCase();
  if (!value) return 'SMTP';
  if (value.includes('gmail') || value.includes('googlemail') || value.includes('google.com')) return 'Gmail';
  if (value.includes('amazonaws.com') || value.includes('ses.')) return 'Amazon SES';
  return 'Custom SMTP';
}

function resolveSmtpSecure(value, port) {
  if (Number(port) === 465) return true;
  return value === true || value === 'true';
}

/**
 * Opens an SMTP session and checks the configured credentials.
 * Does not send a message. A missing password is reported as not configured.
 */
export async function checkSmtpConnection(overrides = {}, { cache = false } = {}) {
  const host = overrides.host || env.SMTP_HOST;
  const port = Number(overrides.port || env.SMTP_PORT) || 587;
  const user = overrides.user !== undefined ? overrides.user : env.SMTP_USER;
  const pass = overrides.pass !== undefined ? overrides.pass : env.SMTP_PASS;
  const secure = resolveSmtpSecure(
    overrides.secure !== undefined ? overrides.secure : env.SMTP_SECURE,
    port
  );
  const provider = smtpProviderLabel(host);

  if (!user || !pass) {
    return {
      status: 'degraded',
      connected: false,
      configured: false,
      provider: null,
      host: host || null,
      port,
      secure,
      error: 'SMTP credentials are not configured'
    };
  }

  const cacheable = cache && overrides.user === undefined && overrides.pass === undefined && overrides.host === undefined;
  if (cacheable && cachedSmtpCheck && Date.now() - cachedSmtpCheckedAt < SMTP_HEALTH_CACHE_MS) {
    return cachedSmtpCheck;
  }

  const probe = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: SMTP_VERIFY_TIMEOUT_MS,
    greetingTimeout: SMTP_VERIFY_TIMEOUT_MS,
    socketTimeout: SMTP_VERIFY_TIMEOUT_MS
  });

  try {
    await probe.verify();
    const result = {
      status: 'ok',
      connected: true,
      configured: true,
      provider,
      host,
      port,
      secure,
      error: null
    };
    if (cacheable) {
      cachedSmtpCheck = result;
      cachedSmtpCheckedAt = Date.now();
    }
    return result;
  } catch (err) {
    return {
      status: 'error',
      connected: false,
      configured: true,
      provider,
      host,
      port,
      secure,
      error: err.message || 'SMTP verification failed'
    };
  } finally {
    try {
      probe.close();
    } catch {
      // The probe socket may already be closed.
    }
  }
}

function getTransporter() {
  if (transporter) return transporter;

  if (env.SMTP_USER && env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: resolveSmtpSecure(env.SMTP_SECURE, env.SMTP_PORT),
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS
      },
      connectionTimeout: SMTP_VERIFY_TIMEOUT_MS,
      greetingTimeout: SMTP_VERIFY_TIMEOUT_MS,
      socketTimeout: SMTP_VERIFY_TIMEOUT_MS
    });
  }
  return transporter;
}

/**
 * Dispatches an email via SMTP (or safe simulation if credentials not configured),
 * and persists the audit record into app.email_logs.
 *
 * @param {object} options
 * @param {string} [options.tenantId]
 * @param {string} options.to
 * @param {string} options.subject
 * @param {string} options.html
 * @param {string} [options.text]
 * @param {string} options.templateName
 * @param {object} [options.metadata]
 * @returns {Promise<{success: boolean, status: string, messageId?: string, error?: string}>}
 */
export async function sendEmail({
  tenantId = null,
  to,
  subject,
  html,
  text = '',
  templateName = 'general',
  metadata = {}
}) {
  const from = env.SMTP_FROM || 'KapadKart Support <support@kapadkart.com>';
  const normalizedTo = String(to).trim().toLowerCase();

  const client = getTransporter();

  let status = 'sent';
  let messageId = null;
  let errorMessage = null;

  if (client) {
    try {
      const info = await client.sendMail({
        from,
        to: normalizedTo,
        subject,
        text: text || html.replace(/<[^>]*>?/gm, ''),
        html
      });
      messageId = info.messageId;
      status = 'sent';
    } catch (err) {
      status = 'failed';
      errorMessage = err.message || 'SMTP dispatch failed';
      console.error(`[EmailService] Failed to send email to ${normalizedTo}:`, err.message);
    }
  } else {
    // Development / fallback simulation
    messageId = `sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    status = 'simulated';
    console.log(`[EmailService] SMTP not fully configured. Simulated email to ${normalizedTo} [${templateName}]`);
  }

  // Persist into app.email_logs
  try {
    await prisma.emailLog.create({
      data: {
        tenantId: tenantId || null,
        provider: 'smtp',
        fromAddress: from,
        toAddress: normalizedTo,
        subject,
        templateName,
        status,
        messageId,
        errorMessage,
        metadata: metadata || {},
        sentAt: new Date()
      }
    });
  } catch (logErr) {
    console.error('[EmailService] Failed to write into app.email_logs:', logErr.message);
  }

  return {
    success: status === 'sent' || status === 'simulated',
    status,
    messageId,
    error: errorMessage
  };
}

/**
 * Builds HTML template for 6-Digit Password Reset OTP
 */
export function buildPasswordResetOtpHtml({ otp, expiryMinutes = 10, supportEmail = 'support@kapadkart.com' }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>KapadKart Verification Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .card { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 36px 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .logo { font-size: 24px; font-weight: 800; color: #d97706; letter-spacing: -0.5px; margin-bottom: 24px; }
    .title { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 20px; }
    .otp-box { background: #fef3c7; border: 1.5px dashed #f59e0b; border-radius: 10px; padding: 20px; text-align: center; margin: 24px 0; }
    .otp-code { font-family: monospace; font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #92400e; margin: 0; }
    .badge { display: inline-block; font-size: 12px; font-weight: 600; color: #b45309; background: #fef3c7; padding: 4px 10px; border-radius: 6px; margin-top: 8px; }
    .footer { font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">KapadKart</div>
    <h1 class="title">Password Reset Verification Code</h1>
    <p class="text">You recently requested to reset your password for your KapadKart account. Use the verification code below to complete the process:</p>
    
    <div class="otp-box">
      <div class="otp-code">${otp}</div>
      <div class="badge">Valid for ${expiryMinutes} minutes</div>
    </div>

    <p class="text"><strong>Never share this code with anyone.</strong> Our support staff will never ask for your verification code or password.</p>
    <p class="text">If you did not request a password reset, you can safely ignore this email or reach out to <a href="mailto:${supportEmail}">${supportEmail}</a> if you have security concerns.</p>

    <div class="footer">
      KapadKart — Multi-Tenant Rental Booking, POS & Inventory ERP<br />
      This is an automated security notification.
    </div>
  </div>
</body>
</html>`;
}

/**
 * Builds HTML template for New Shop Welcome Email
 */
export function buildWelcomeShopHtml({
  shopName,
  slug,
  ownerEmail,
  temporaryPassword,
  loginUrl = emailLinksForRequest().loginUrl,
  supportEmail = 'support@kapadkart.com'
}) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to KapadKart</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .card { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 36px 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .logo { font-size: 26px; font-weight: 800; color: #d97706; letter-spacing: -0.5px; margin-bottom: 20px; }
    .title { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 18px; }
    .credentials { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin: 20px 0; }
    .cred-row { font-size: 13px; margin-bottom: 8px; }
    .cred-row:last-child { margin-bottom: 0; }
    .cred-label { font-weight: 600; color: #64748b; width: 110px; display: inline-block; }
    .cred-val { font-family: monospace; font-weight: 600; color: #0f172a; }
    .btn { display: inline-block; background: #d97706; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; margin: 16px 0; }
    .footer { font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">KapadKart</div>
    <h1 class="title">Welcome to KapadKart, ${shopName}! 🎉</h1>
    <p class="text">Your shop account has been created on the KapadKart platform. You can now manage your rental inventory, bookings, sales, POS, and customer billing with ease.</p>
    
    <div class="credentials">
      <div class="cred-row"><span class="cred-label">Shop Slug:</span> <span class="cred-val">${slug}</span></div>
      <div class="cred-row"><span class="cred-label">Login Email:</span> <span class="cred-val">${ownerEmail}</span></div>
      ${temporaryPassword ? `<div class="cred-row"><span class="cred-label">Password:</span> <span class="cred-val">${temporaryPassword}</span></div>` : ''}
    </div>

    <div style="text-align: center;">
      <a href="${loginUrl}" class="btn">Access Your Shop Dashboard</a>
    </div>

    <p class="text">For security, we recommend that you change your password upon your first sign in from your Shop Settings.</p>
    <p class="text">Need help getting started? Contact our team at <a href="mailto:${supportEmail}">${supportEmail}</a> or visit our Support page.</p>

    <div class="footer">
      KapadKart — Multi-Tenant Rental Booking, POS & Inventory ERP<br />
      Welcome aboard!
    </div>
  </div>
</body>
</html>`;
}

/**
 * Builds HTML template for Account Suspension Notification
 */
export function buildAccountSuspendedHtml({
  shopName,
  ownerName,
  suspensionDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
  reason = 'Administrative Review',
  customReason = '',
  supportEmail = 'support@kapadkart.com',
  supportPhone = '+91 7227807493',
  supportUrl = emailLinksForRequest().supportUrl
}) {
  const reasonLabels = {
    'outstanding_payment': 'Outstanding Payment (Pending or Overdue Invoices)',
    'unusual_activity': 'Unusual Activity (Suspicious or Potentially Unauthorized Activity)',
    'account_sharing': 'Account Sharing (Suspected Credential Sharing or Policy Violation)',
    'other': customReason || 'Administrative Review & Compliance Safeguard'
  };

  const displayReason = reasonLabels[reason] || customReason || reason || 'Administrative Review';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Account Has Been Suspended</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .card { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #fee2e2; padding: 36px 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .logo { font-size: 26px; font-weight: 800; color: #d97706; letter-spacing: -0.5px; margin-bottom: 20px; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; background: #fee2e2; color: #991b1b; padding: 6px 14px; border-radius: 9999px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px; }
    .title { font-size: 22px; font-weight: 700; color: #991b1b; margin-top: 0; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px; }
    .details-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin: 20px 0; }
    .row { font-size: 13px; margin-bottom: 8px; }
    .row:last-child { margin-bottom: 0; }
    .label { font-weight: 600; color: #7f1d1d; width: 140px; display: inline-block; }
    .val { font-weight: 600; color: #1e293b; }
    .notice { background: #f8fafc; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 0 8px 8px 0; font-size: 13px; color: #475569; margin: 20px 0; }
    .contact-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin-top: 24px; font-size: 13px; }
    .contact-item { margin-bottom: 6px; }
    .contact-item:last-child { margin-bottom: 0; }
    .footer { font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">KapadKart</div>
    <div class="status-badge">⚠️ Notice of Account Suspension</div>
    <h1 class="title">Your Account Has Been Suspended</h1>
    <p class="text">Hello ${ownerName ? `<strong>${ownerName}</strong>` : 'Shop Administrator'},</p>
    <p class="text">This email is an official notification that your KapadKart shop account for <strong>${shopName}</strong> has been suspended by an authorized platform administrator. Access to your shop dashboard, rental inventory, bookings, POS, and public portal has been restricted.</p>

    <div class="details-box">
      <div class="row"><span class="label">Shop Name:</span> <span class="val">${shopName}</span></div>
      <div class="row"><span class="label">Suspension Date:</span> <span class="val">${suspensionDate}</span></div>
      <div class="row"><span class="label">Reason:</span> <span class="val">${displayReason}</span></div>
    </div>

    <div class="notice">
      <strong>Important Notice Regarding Account Reactivation:</strong><br />
      Reactivation is subject to review and verification by the KapadKart administration and compliance team. Accounts are not reactivated automatically.
    </div>

    <p class="text">To discuss this suspension, resolve any outstanding matters, and request an account reactivation review, please contact our support team:</p>

    <div class="contact-box">
      <div class="contact-item"><strong>Support Email:</strong> <a href="mailto:${supportEmail}">${supportEmail}</a></div>
      <div class="contact-item"><strong>Support Helpline:</strong> <a href="tel:${supportPhone.replace(/\s+/g, '')}">${supportPhone}</a></div>
      <div class="contact-item"><strong>Help & Support Page:</strong> <a href="${supportUrl}">${supportUrl}</a></div>
    </div>

    <div class="footer">
      KapadKart — Multi-Tenant Rental Booking, POS & Inventory ERP<br />
      Platform Security & Administrative Notification
    </div>
  </div>
</body>
</html>`;
}

/**
 * Builds HTML template for Shop / User Information Update Notification
 */
export function buildAccountUpdatedHtml({
  shopName,
  ownerName,
  updatedFields = [],
  updatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
  supportEmail = 'support@kapadkart.com',
  supportPhone = '+91 7227807493'
}) {
  const fieldsList = updatedFields.length > 0
    ? updatedFields.map((f) => `<li style="margin-bottom: 4px;"><strong>${f}</strong></li>`).join('')
    : '<li>Account Profile & Settings</li>';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Account Information Was Updated</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .card { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 36px 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .logo { font-size: 26px; font-weight: 800; color: #d97706; letter-spacing: -0.5px; margin-bottom: 20px; }
    .title { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 16px; }
    .box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin: 20px 0; }
    .list { margin: 8px 0 0 18px; padding: 0; font-size: 13px; color: #0f172a; }
    .warning { background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 14px; font-size: 13px; color: #92400e; margin: 20px 0; }
    .footer { font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">KapadKart</div>
    <h1 class="title">Account Details Updated</h1>
    <p class="text">Hello ${ownerName ? `<strong>${ownerName}</strong>` : 'Shop Administrator'},</p>
    <p class="text">This email confirms that an authorized platform administrator has updated information for your shop account <strong>${shopName}</strong> on <strong>${updatedAt}</strong>.</p>
    
    <div class="box">
      <div style="font-size: 13px; font-weight: 600; color: #64748b; margin-bottom: 6px;">Updated Attributes:</div>
      <ul class="list">
        ${fieldsList}
      </ul>
    </div>

    <div class="warning">
      <strong>Didn't request or expect this change?</strong><br />
      If you did not authorize these modifications, please reach out to our support team immediately at <a href="mailto:${supportEmail}">${supportEmail}</a> or call <a href="tel:${supportPhone.replace(/\s+/g, '')}">${supportPhone}</a> so we can investigate.
    </div>

    <div class="footer">
      KapadKart — Multi-Tenant Rental Booking, POS & Inventory ERP<br />
      Security & Account Notification
    </div>
  </div>
</body>
</html>`;
}

