import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment files with fallback order: .env.local -> .env
const cwd = process.cwd();
const envPaths = [
  path.resolve(cwd, '.env.local'),
  path.resolve(cwd, '.env'),
  path.resolve(cwd, '../.env.local'),
  path.resolve(cwd, '../.env')
];

for (const envPath of envPaths) {
  dotenv.config({ path: envPath });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  // Public shop app origin embedded in email links. No trailing slash.
  // Leave unset so local API requests use http://localhost:5173 and live
  // requests use https://kapadkart.pages.dev.
  SHOP_APP_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Local PostgreSQL. The API connects with these values.
  // DATABASE_URL in .env is read by the Prisma CLI and must point at the same database.
  LOCAL_DB_HOST: z.string().default('localhost'),
  LOCAL_DB_PORT: z.coerce.number().int().positive().default(5432),
  LOCAL_DB_USER: z.string().default('postgres'),
  LOCAL_DB_PASSWORD: z.string().optional(),
  LOCAL_DB_NAME: z.string().default('kapadkart'),

  // JWT Cryptographic Authentication Configuration
  JWT_SECRET: z.string().min(16).default('kapadkart_super_secure_jwt_secret_key_2026_dev_prod'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  JWT_ADMIN_EXPIRES_IN: z.string().default('8h'),

  // Cookie Security & Cross-Domain Scoping (Cloudflare Pages + API host)
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAME_SITE: z.enum(['lax', 'none', 'strict']).optional(),

  // Files. Image bytes go to R2 when STORAGE_PROVIDER=r2. Databases store the URL only.
  STORAGE_PROVIDER: z.enum(['local', 's3', 'r2']).default('local'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),

  // SMTP Email Configuration (Nodemailer / Gmail)
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.preprocess((val) => val === true || val === 'true', z.boolean()).default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('KapadKart Support <support@kapadkart.com>')
}).superRefine((data, ctx) => {
  if (data.STORAGE_PROVIDER !== 'r2') return;

  const required = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_PUBLIC_URL'
  ];

  for (const key of required) {
    if (!data[key] || !String(data[key]).trim()) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when STORAGE_PROVIDER=r2`
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid backend environment configuration:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

const env = parsed.data;

// Parse allowed origins array (trim whitespace, eliminate empty strings)
const allowedOrigins = env.FRONTEND_ORIGIN
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export { env, allowedOrigins };
