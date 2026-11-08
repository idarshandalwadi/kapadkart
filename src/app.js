import express from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { allowedOrigins } from './config/env.js';
import { requestLogger } from './middleware/loggerMiddleware.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import apiRouter from './routes/index.js';

const app = express();

// Trust first proxy hop in production / reverse-proxy deployments (Nginx, Cloudflare, ALB)
app.set('trust proxy', 1);

// Security headers with Helmet (allow cross-origin asset loading for image uploads)
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

// Cross-Origin Resource Sharing configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g., mobile apps, curl, server-to-server) or matched origins
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        const corsError = new Error(`Origin '${origin}' is not permitted by CORS policy`);
        corsError.status = 403;
        callback(corsError);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug', 'X-Requested-With'],
    credentials: true
  })
);

// Parse cookies from incoming requests (enables HttpOnly session verification)
app.use(cookieParser());

// Structured request logger (logs method, duration, status; excludes body)
app.use(requestLogger);

// Body parsing with strict size limits to prevent payload abuse
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Static file serving for local image uploads
const uploadsDir = path.resolve(process.cwd(), process.env.LOCAL_UPLOAD_DIR || 'uploads');
app.use(
  '/uploads',
  express.static(uploadsDir, {
    maxAge: '1d',
    dotfiles: 'deny',
    fallthrough: false
  })
);

// Rate limiting on API routes
app.use('/api', apiRateLimiter);

// Root route descriptor
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'kapadkart-api',
    status: 'running',
    apiDocumentation: '/api/v1'
  });
});

// API v1 routes
app.use('/api/v1', apiRouter);

// 404 handler for unknown routes
app.use(notFoundHandler);

// Centralized error handling
app.use(errorHandler);

export default app;
