import { Router } from 'express';
import { requireTenant } from '../middleware/authMiddleware.js';

import overviewRoutes, { handlePublicTenantBranding, handleTenantOverview } from './tenant/overview.routes.js';
import productsRoutes from './tenant/products.routes.js';
import bookingsRoutes from './tenant/bookings.routes.js';
import salesRoutes from './tenant/sales.routes.js';
import settingsRoutes from './tenant/settings.routes.js';
import catalogRoutes from './tenant/catalog.routes.js';
import reportsRoutes from './tenant/reports.routes.js';

const router = Router();

/**
 * Re-export public branding handler for admin.routes.js backward compatibility
 */
export { handlePublicTenantBranding, handleTenantOverview };

/**
 * Tenant protected path list requiring multi-tenant auth context
 */
const tenantProtectedPaths = [
  '/products',
  '/bookings',
  '/sales',
  '/settings',
  '/categories',
  '/brands',
  '/overview',
  '/dashboard',
  '/sales-reports',
  '/returns-schedule',
  '/activity',
  '/performance'
];

tenantProtectedPaths.forEach((path) => {
  router.use(path, requireTenant);
});

router.use('/', (req, res, next) => {
  if (req.baseUrl.endsWith('/tenant')) {
    return requireTenant(req, res, next);
  }
  next();
});

// Mount modular sub-routers
router.use('/', overviewRoutes);
router.use('/', productsRoutes);
router.use('/', bookingsRoutes);
router.use('/', salesRoutes);
router.use('/', settingsRoutes);
router.use('/', catalogRoutes);
router.use('/', reportsRoutes);

export default router;
