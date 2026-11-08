import rateLimit from 'express-rate-limit';

export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 5000 : 100, // Generous in development, strict in production
  standardHeaders: 'draft-8', // Return RateLimit headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  message: {
    status: 'error',
    message: 'Too many requests from this IP. Please try again after 15 minutes.'
  }
});
