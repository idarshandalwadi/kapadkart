import { Router } from 'express';
import { z } from 'zod';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import tenantRoutes from './tenant.routes.js';
import uploadRoutes from './upload.routes.js';
import emailRoutes from './email.routes.js';
import publicRoutes from './public.routes.js';
import { validateRequest } from '../middleware/validate.js';

const apiRouter = Router();

// Root API v1 welcome endpoint
apiRouter.get('/', (req, res) => {
  res.status(200).json({
    service: 'kapadkart-api',
    version: '1.0.0',
    message: 'Welcome to KapadKart API v1',
    endpoints: {
      health: '/api/v1/health',
      auth: '/api/v1/auth',
      admin: '/api/v1/admin',
      tenant: '/api/v1/tenant',
      public: '/api/v1/public',
      upload: '/api/v1/upload',
      emails: '/api/v1/emails',
      validateExample: '/api/v1/validate-example'
    }
  });
});

// Mount modules
apiRouter.use('/', healthRoutes);
apiRouter.use('/public', publicRoutes);
apiRouter.use('/auth', authRoutes);
apiRouter.use('/platform-auth', authRoutes);
apiRouter.use('/admin', adminRoutes);
apiRouter.use('/platform', adminRoutes);
apiRouter.use('/tenants', adminRoutes);
apiRouter.use('/tenant', tenantRoutes);
apiRouter.use('/', tenantRoutes);
apiRouter.use('/upload', uploadRoutes);
apiRouter.use('/uploads', uploadRoutes);
apiRouter.use('/emails', emailRoutes);
apiRouter.use('/admin/emails', emailRoutes);

// Example schema demonstrating Zod request validation
const contactExampleSchema = z.object({
  email: z.string().email('Please provide a valid email address'),
  message: z.string().min(3, 'Message must be at least 3 characters long')
});

// Example endpoint utilizing Zod validation middleware
apiRouter.post('/validate-example', validateRequest(contactExampleSchema), (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Input validated successfully with Zod schema.',
    data: req.validatedBody
  });
});

export default apiRouter;
