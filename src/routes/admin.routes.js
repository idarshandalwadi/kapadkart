import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma, checkPrismaConnection } from '../config/prisma.js';
import { uploadSingleImage } from '../middleware/upload.middleware.js';
import { storageService } from '../services/storage/index.js';
import { requireAdmin } from '../middleware/authMiddleware.js';
import {
  sendEmail,
  emailLinksForRequest,
  checkSmtpConnection,
  buildWelcomeShopHtml,
  buildAccountSuspendedHtml,
  buildAccountUpdatedHtml
} from '../services/email/emailService.js';
import { handlePublicTenantBranding } from './tenant.routes.js';

const router = Router();

// Public tenant branding endpoint (accessible without admin session)
router.get('/:slug/branding', handlePublicTenantBranding);
router.get('/tenants/:slug/branding', handlePublicTenantBranding);

router.use(requireAdmin);

function parseLimitInput(val) {
  if (val === undefined) return undefined;
  if (val === null || val === '' || val === 'null' || val === 'unlimited' || val === -1) return null;
  const num = parseInt(val, 10);
  if (isNaN(num) || num < 0) return null;
  return num;
}

/**
 * GET /health and /dashboard/health
 * Live platform system infrastructure status
 */
const handleHealth = async (req, res, next) => {
  try {
    const [dbHealth, smtp] = await Promise.all([
      checkPrismaConnection(),
      checkSmtpConnection({}, { cache: true })
    ]);
    const dbOk = dbHealth.status === 'connected';
    const smtpOk = smtp.status === 'ok';

    res.status(200).json({
      status: 'success',
      data: {
        status: dbOk && smtpOk ? 'operational' : 'degraded',
        timestamp: new Date().toISOString(),
        api: {
          status: 'ok',
          uptime_seconds: Math.floor(process.uptime()),
          version: '1.0.0'
        },
        database: {
          status: dbOk ? 'ok' : 'error',
          latency_ms: dbHealth.latencyMs || 0,
          source: dbHealth.source,
          error: dbHealth.error || null
        },
        smtp: {
          status: smtp.status,
          configured: smtp.configured,
          connected: smtp.connected,
          provider: smtp.provider,
          host: smtp.host,
          port: smtp.port,
          error: smtp.error
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

router.get('/health', handleHealth);
router.get('/dashboard/health', handleHealth);

/**
 * GET /summary and /dashboard/summary
 * Live KPI executive summary for Platform Dashboard
 */
const handleSummary = async (req, res, next) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      totalShops,
      activeShops,
      suspendedShops,
      deletedShops,
      newShopsThisMonth,
      usersTotal,
      productsTotal,
      bookingsTotal,
      salesAgg,
      topTenants
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'active' } }),
      prisma.tenant.count({ where: { status: 'suspended' } }),
      prisma.tenant.count({ where: { status: 'deleted' } }),
      prisma.tenant.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.user.count(),
      prisma.product.count(),
      prisma.booking.count(),
      prisma.sale.aggregate({
        _count: true,
        _sum: { saleTotal: true }
      }),
      prisma.tenant.findMany({
        include: {
          settings: true,
          _count: {
            select: { bookings: true, sales: true }
          },
          sales: {
            select: { saleTotal: true }
          }
        }
      })
    ]);

    const formattedTopShops = topTenants
      .map((t) => {
        const revenue = t.sales.reduce((acc, s) => acc + Number(s.saleTotal || 0), 0);
        return {
          id: t.id,
          slug: t.slug,
          name: t.name,
          company_name: t.settings?.companyName || t.name,
          currency: t.settings?.currency || 'INR',
          booking_count: t._count.bookings,
          sale_count: t._count.sales,
          revenue,
          status: t.status
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const totalRevenue = Number(salesAgg._sum.saleTotal || 0);

    const summary = {
      total_shops: totalShops,
      active_shops: activeShops,
      suspended_shops: suspendedShops,
      deleted_shops: deletedShops,
      new_shops_this_month: newShopsThisMonth,
      new_shops_last_month: 0,
      total_revenue: totalRevenue,
      currency: 'INR',
      rental_count: bookingsTotal,
      sale_count: salesAgg._count,
      total_users: usersTotal,
      top_shops: formattedTopShops,
      needs_attention: [],
      range_label: '30 Days',
      shop_overview: {
        total_shops: totalShops,
        active_shops: activeShops,
        suspended_shops: suspendedShops,
        deleted_shops: deletedShops,
        new_shops_this_month: newShopsThisMonth,
        new_shops_last_month: 0,
        inactive_shops_30d: 0
      },
      activity: {
        total_bookings: bookingsTotal,
        total_sales: salesAgg._count,
        total_transactions: bookingsTotal + salesAgg._count,
        revenue_by_currency: [
          { currency: 'INR', amount: totalRevenue, payment_count: salesAgg._count }
        ]
      },
      email_health: {
        delivery_rate: 100,
        bounce_rate: 0,
        total_sent: 0,
        total_failed: 0,
        status: 'ok'
      }
    };

    res.status(200).json({
      status: 'success',
      data: summary
    });
  } catch (error) {
    next(error);
  }
};

router.get('/summary', handleSummary);
router.get('/dashboard/summary', handleSummary);

/**
 * GET /overview
 * Platform-level KPI overview
 */
router.get('/overview', async (req, res, next) => {
  try {
    const [totalTenants, activeTenants, usersTotal, productsTotal, bookingsTotal, salesAgg, recentLogs] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: 'active' } }),
      prisma.user.count(),
      prisma.product.count(),
      prisma.booking.count(),
      prisma.sale.aggregate({
        _count: true,
        _sum: { saleTotal: true }
      }),
      prisma.activityLog.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { id: true, action: true, entityType: true, summary: true, createdAt: true }
      })
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        tenants: { total: totalTenants, active: activeTenants },
        users: usersTotal,
        products: productsTotal,
        bookings: bookingsTotal,
        sales: {
          totalCount: salesAgg._count,
          estimatedRevenue: Number(salesAgg._sum.saleTotal || 0)
        },
        recentActivity: recentLogs.map((l) => ({
          id: l.id,
          action: l.action,
          entity_type: l.entityType,
          summary: l.summary,
          created_at: l.createdAt
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Tenant Shop Listing handler
 */
const handleListTenants = async (req, res, next) => {
  try {
    const includeDeleted = req.query.include_deleted === 'true';
    const where = includeDeleted ? {} : { status: { not: 'deleted' } };

    const tenants = await prisma.tenant.findMany({
      where,
      include: {
        settings: true,
        users: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, email: true, originalEmail: true, fullName: true }
        },
        _count: {
          select: { users: true, products: true, bookings: true, sales: true }
        },
        sales: {
          select: { saleTotal: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const rows = tenants.map((t) => {
      const ownerUser = t.users[0] || null;
      const owner = ownerUser
        ? {
            id: ownerUser.id,
            email: ownerUser.originalEmail || ownerUser.email,
            original_email: ownerUser.originalEmail,
            full_name: ownerUser.fullName
          }
        : null;

      const revenue = t.sales.reduce((acc, s) => acc + Number(s.saleTotal || 0), 0);

      return {
        id: t.id,
        slug: t.slug,
        original_slug: t.originalSlug,
        name: t.name,
        status: t.status,
        business_type: t.businessType,
        max_products: t.maxProducts,
        max_bookings: t.maxBookings,
        max_sales: t.maxSales,
        created_by: t.createdBy,
        created_at: t.createdAt,
        company_name: t.settings?.companyName || null,
        phone_number: t.settings?.phoneNumber || null,
        address: t.settings?.address || null,
        currency: t.settings?.currency || null,
        logo_url: t.settings?.logoUrl || null,
        owner,
        user_count: t._count.users,
        product_count: t._count.products,
        booking_count: t._count.bookings,
        sale_count: t._count.sales,
        revenue
      };
    });

    res.status(200).json({
      status: 'success',
      data: rows
    });
  } catch (error) {
    next(error);
  }
};

router.get('/tenants', handleListTenants);
router.get('/', handleListTenants);

/**
 * Tenant Deep Detail handler
 */
const handleTenantDetail = async (req, res, next) => {
  try {
    const { slug } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      include: {
        settings: true,
        users: {
          select: { id: true, email: true, fullName: true, createdAt: true }
        },
        products: {
          take: 10,
          select: {
            id: true,
            productName: true,
            productCode: true,
            size: true,
            totalQuantity: true,
            dailyRent: true,
            salePrice: true,
            status: true
          }
        },
        bookings: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            billNo: true,
            customerName: true,
            status: true,
            rentalTotal: true,
            pickupDate: true,
            returnDate: true
          }
        },
        sales: {
          select: { saleTotal: true }
        }
      }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    const totalRevenue = tenant.sales.reduce((acc, s) => acc + Number(s.saleTotal || 0), 0);

    const ownerUser = tenant.users[0] || null;
    const owner = ownerUser
      ? {
          id: ownerUser.id,
          email: ownerUser.originalEmail || ownerUser.email,
          full_name: ownerUser.fullName,
          created_at: ownerUser.createdAt
        }
      : null;

    const settingsObj = {
      company_name: tenant.settings?.companyName || null,
      page_title: tenant.settings?.pageTitle || null,
      phone_number: tenant.settings?.phoneNumber || null,
      address: tenant.settings?.address || null,
      gst_number: tenant.settings?.gstNumber || null,
      currency: tenant.settings?.currency || null,
      tax_rate: tenant.settings?.taxRate || null,
      upi_id: tenant.settings?.upiId || null,
      logo_url: tenant.settings?.logoUrl || null,
      favicon_url: tenant.settings?.faviconUrl || null,
      terms_and_conditions: tenant.settings?.termsAndConditions || null
    };

    const formattedTenant = {
      id: tenant.id,
      slug: tenant.slug,
      original_slug: tenant.originalSlug,
      name: tenant.name,
      status: tenant.status,
      business_type: tenant.businessType,
      max_products: tenant.maxProducts,
      max_bookings: tenant.maxBookings,
      max_sales: tenant.maxSales,
      created_by: tenant.createdBy,
      created_by_admin_id: tenant.createdByAdminId,
      created_at: tenant.createdAt,
      updated_at: tenant.updatedAt,
      ...settingsObj,
      settings: settingsObj,
      owner
    };

    const formattedUsers = tenant.users.map((u) => ({
      id: u.id,
      email: u.email,
      full_name: u.fullName,
      created_at: u.createdAt
    }));

    const formattedProducts = tenant.products.map((p) => ({
      id: p.id,
      product_name: p.productName,
      product_code: p.productCode,
      size: p.size,
      total_quantity: p.totalQuantity,
      daily_rent: p.dailyRent,
      sale_price: p.salePrice,
      status: p.status
    }));

    const formattedBookings = tenant.bookings.map((b) => ({
      id: b.id,
      bill_no: b.billNo,
      customer_name: b.customerName,
      status: b.status,
      rental_total: b.rentalTotal,
      pickup_date: b.pickupDate,
      return_date: b.returnDate
    }));

    res.status(200).json({
      status: 'success',
      data: {
        ...formattedTenant,
        shop: formattedTenant,
        tenant: formattedTenant,
        owner,
        settings: settingsObj,
        users: formattedUsers,
        products: formattedProducts,
        bookings: formattedBookings,
        metrics: {
          total_revenue: totalRevenue,
          total_sales: tenant.sales.length,
          total_users: formattedUsers.length,
          total_products: formattedProducts.length,
          total_bookings: formattedBookings.length
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

router.get('/tenants/:slug/detail', handleTenantDetail);
router.get('/:slug/detail', handleTenantDetail);

/**
 * Tenant Users
 */
const handleTenantUsers = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    const users = await prisma.user.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, fullName: true, createdAt: true }
    });

    res.status(200).json({
      status: 'success',
      data: users.map((u) => ({
        id: u.id,
        email: u.email,
        full_name: u.fullName,
        created_at: u.createdAt
      }))
    });
  } catch (error) {
    next(error);
  }
};

router.get('/tenants/:slug/users', handleTenantUsers);
router.get('/:slug/users', handleTenantUsers);

/**
 * Tenant Activity
 */
const handleTenantActivity = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    const logs = await prisma.activityLog.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    res.status(200).json({
      status: 'success',
      data: logs.map((l) => ({
        id: l.id,
        tenant_id: l.tenantId,
        user_id: l.userId,
        user_email: l.userEmail,
        user_name: l.userName,
        action: l.action,
        entity_type: l.entityType,
        entity_id: l.entityId,
        summary: l.summary,
        metadata: l.metadata,
        created_at: l.createdAt
      }))
    });
  } catch (error) {
    next(error);
  }
};

router.get('/tenants/:slug/activity', handleTenantActivity);
router.get('/:slug/activity', handleTenantActivity);

/**
 * Tenant Notes (Mock Handlers)
 */
const handleTenantNotes = async (req, res) => {
  res.status(200).json({ status: 'success', data: [] });
};
router.get('/tenants/:slug/notes', handleTenantNotes);
router.get('/:slug/notes', handleTenantNotes);
router.post('/tenants/:slug/notes', (req, res) => {
  res.status(201).json({ status: 'success', message: 'Note added', data: { content: req.body.content } });
});
router.post('/:slug/notes', (req, res) => {
  res.status(201).json({ status: 'success', message: 'Note added', data: { content: req.body.content } });
});

/**
 * GET Single Tenant
 */
const handleGetTenant = async (req, res, next) => {
  try {
    const { slug } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      include: {
        settings: true,
        users: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { id: true, email: true, originalEmail: true, fullName: true, createdAt: true }
        }
      }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    const ownerUser = tenant.users[0] || null;
    const owner = ownerUser
      ? {
          id: ownerUser.id,
          email: ownerUser.originalEmail || ownerUser.email,
          full_name: ownerUser.fullName,
          created_at: ownerUser.createdAt
        }
      : null;

    const formattedTenant = {
      id: tenant.id,
      slug: tenant.slug,
      original_slug: tenant.originalSlug,
      name: tenant.name,
      status: tenant.status,
      business_type: tenant.businessType,
      businessType: tenant.businessType,
      max_products: tenant.maxProducts,
      max_bookings: tenant.maxBookings,
      max_sales: tenant.maxSales,
      maxProducts: tenant.maxProducts,
      maxBookings: tenant.maxBookings,
      maxSales: tenant.maxSales,
      created_by: tenant.createdBy,
      created_by_admin_id: tenant.createdByAdminId,
      created_at: tenant.createdAt,
      updated_at: tenant.updatedAt,
      company_name: tenant.settings?.companyName || null,
      page_title: tenant.settings?.pageTitle || null,
      phone_number: tenant.settings?.phoneNumber || null,
      address: tenant.settings?.address || null,
      gst_number: tenant.settings?.gstNumber || null,
      currency: tenant.settings?.currency || null,
      tax_rate: tenant.settings?.taxRate || null,
      upi_id: tenant.settings?.upiId || null,
      logo_url: tenant.settings?.logoUrl || null
    };

    res.status(200).json({
      status: 'success',
      data: {
        ...formattedTenant,
        tenant: formattedTenant,
        shop: formattedTenant,
        owner
      }
    });
  } catch (error) {
    next(error);
  }
};

router.get('/tenants/:slug', handleGetTenant);
router.get('/:slug', handleGetTenant);

/**
 * POST Create Tenant
 */
const handleCreateTenant = async (req, res, next) => {
  try {
    const {
      name,
      slug,
      businessType,
      business_type,
      max_products,
      maxProducts,
      max_bookings,
      maxBookings,
      max_sales,
      maxSales,
      phone = '',
      address = '',
      company_name = '',
      page_title = '',
      phone_number = '',
      currency = 'INR',
      logo_url = '',
      owner_email = '',
      owner_full_name = '',
      owner_password = ''
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ status: 'error', message: 'Tenant name and slug are required' });
    }

    const requestedType = businessType || business_type || 'SALES_AND_RENTAL';
    const validBusinessTypes = ['SALES', 'RENTAL', 'SALES_AND_RENTAL'];
    const resolvedBusinessType = validBusinessTypes.includes(requestedType) ? requestedType : 'SALES_AND_RENTAL';

    const parsedMaxProducts = parseLimitInput(max_products !== undefined ? max_products : maxProducts);
    const parsedMaxBookings = parseLimitInput(max_bookings !== undefined ? max_bookings : maxBookings);
    const parsedMaxSales = parseLimitInput(max_sales !== undefined ? max_sales : maxSales);

    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const effectivePhone = phone_number || phone || '';
    const effectiveCompany = company_name || name;
    const effectiveTitle = page_title || effectiveCompany;
    const createdBy = req.user?.email || req.user?.username || 'Platform Admin';
    const createdByAdminId = req.user?.role === 'platform_admin' ? req.user?.sub : null;

    let createdUser = null;
    let newTenant = null;

    await prisma.$transaction(async (tx) => {
      newTenant = await tx.tenant.create({
        data: {
          slug: cleanSlug,
          name,
          businessType: resolvedBusinessType,
          maxProducts: parsedMaxProducts,
          maxBookings: parsedMaxBookings,
          maxSales: parsedMaxSales,
          status: 'active',
          createdBy,
          createdByAdminId
        }
      });

      await tx.setting.create({
        data: {
          tenantId: newTenant.id,
          companyName: effectiveCompany,
          pageTitle: effectiveTitle,
          phoneNumber: effectivePhone,
          address,
          currency,
          logoUrl: logo_url
        }
      });

      if (owner_email && owner_email.trim()) {
        const normalizedEmail = owner_email.trim().toLowerCase();
        const rawPassword = owner_password || 'ShopOwner@123';
        const passwordHash = await bcrypt.hash(rawPassword, 10);
        const fullName = owner_full_name.trim() || `${name} Owner`;

        const user = await tx.user.create({
          data: {
            tenantId: newTenant.id,
            email: normalizedEmail,
            passwordHash,
            fullName
          },
          select: {
            id: true,
            email: true,
            fullName: true,
            createdAt: true
          }
        });

        createdUser = {
          id: user.id,
          email: user.email,
          full_name: user.fullName,
          created_at: user.createdAt
        };
      }
    });

    // Audit log (recorded with valid user_id or null for platform admins)
    prisma.activityLog.create({
      data: {
        tenantId: newTenant.id,
        userId: req.user?.role === 'tenant_user' ? req.user?.sub : null,
        userEmail: createdBy,
        userName: req.user?.fullName || 'Platform Admin',
        action: 'CREATE_SHOP',
        entityType: 'TENANT',
        entityId: newTenant.id,
        summary: `Created shop "${name}" (${cleanSlug})`
      }
    }).catch(() => {});

    if (owner_email && owner_email.trim() && createdUser) {
      const normalizedEmail = owner_email.trim().toLowerCase();
      const rawPassword = owner_password || 'ShopOwner@123';

      // Dispatch Welcome Email via SMTP
      const welcomeHtml = buildWelcomeShopHtml({
        shopName: name,
        slug: cleanSlug,
        ownerEmail: normalizedEmail,
        temporaryPassword: rawPassword,
        loginUrl: emailLinksForRequest(req).loginUrl
      });

      await sendEmail({
        tenantId: newTenant.id,
        to: normalizedEmail,
        subject: `Welcome to KapadKart — Your Shop "${name}" is Ready!`,
        html: welcomeHtml,
        templateName: 'welcome_shop',
        metadata: { tenant_id: newTenant.id, user_id: createdUser.id }
      }).catch((emailErr) => {
        console.error('[Admin] Failed to send welcome email to new shop owner:', emailErr.message);
      });
    }

    res.status(201).json({
      status: 'success',
      message: 'Tenant created successfully',
      data: {
        id: newTenant.id,
        slug: newTenant.slug,
        original_slug: newTenant.originalSlug,
        name: newTenant.name,
        business_type: newTenant.businessType,
        businessType: newTenant.businessType,
        max_products: newTenant.maxProducts,
        max_bookings: newTenant.maxBookings,
        max_sales: newTenant.maxSales,
        maxProducts: newTenant.maxProducts,
        maxBookings: newTenant.maxBookings,
        maxSales: newTenant.maxSales,
        status: newTenant.status,
        created_by: newTenant.createdBy,
        created_by_admin_id: newTenant.createdByAdminId,
        created_at: newTenant.createdAt,
        updated_at: newTenant.updatedAt,
        owner: createdUser
      }
    });
  } catch (error) {
    next(error);
  }
};

router.post('/tenants', handleCreateTenant);
router.post('/', handleCreateTenant);

/**
 * PUT Update Tenant
 */
const handleUpdateTenant = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const {
      name,
      businessType,
      business_type,
      max_products,
      maxProducts,
      max_bookings,
      maxBookings,
      max_sales,
      maxSales,
      status,
      company_name,
      companyName,
      page_title,
      pageTitle,
      phone,
      phone_number,
      address,
      currency,
      logo_url,
      gstNumber,
      gst_number,
      owner_email,
      owner_full_name,
      owner_password,
      reason,
      customReason
    } = req.body;

    // 1. Fetch current tenant, settings, and owner
    const existingTenant = await prisma.tenant.findUnique({
      where: { slug },
      include: {
        settings: true,
        users: {
          orderBy: { createdAt: 'asc' },
          take: 1
        }
      }
    });

    if (!existingTenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    const existingOwner = existingTenant.users[0] || null;

    // 2. IMMUTABLE EMAIL VALIDATION
    if (existingOwner && owner_email !== undefined && owner_email !== null && String(owner_email).trim()) {
      const normalizedNewEmail = String(owner_email).trim().toLowerCase();
      const normalizedCurrentEmail = String(existingOwner.email).trim().toLowerCase();
      if (normalizedNewEmail !== normalizedCurrentEmail) {
        return res.status(400).json({
          status: 'error',
          code: 'EMAIL_IMMUTABLE',
          message: 'Shop registered email address is immutable and cannot be changed.'
        });
      }
    }

    // 3. BUSINESS TYPE TRANSITION VALIDATION
    const targetBusinessType = businessType !== undefined ? businessType : business_type;
    if (targetBusinessType !== undefined && targetBusinessType !== existingTenant.businessType) {
      // Rule 1: SALES_AND_RENTAL cannot be downgraded to single business type
      if (existingTenant.businessType === 'SALES_AND_RENTAL') {
        return res.status(400).json({
          status: 'error',
          code: 'BUSINESS_TYPE_DOWNGRADE_DISALLOWED',
          message: 'A shop configured for Both Rental & Sales cannot be downgraded to a single business type.'
        });
      }

      // Rule 2: SALES -> RENTAL only allowed if 0 sales products and 0 sales bills
      if (existingTenant.businessType === 'SALES' && targetBusinessType === 'RENTAL') {
        const [salesProductsCount, salesBillsCount] = await Promise.all([
          prisma.product.count({
            where: {
              tenantId: existingTenant.id,
              availabilityType: { in: ['sell', 'both'] }
            }
          }),
          prisma.sale.count({
            where: { tenantId: existingTenant.id }
          })
        ]);

        if (salesProductsCount > 0 || salesBillsCount > 0) {
          return res.status(400).json({
            status: 'error',
            code: 'BUSINESS_TYPE_CHANGE_BLOCKED',
            message: `Cannot change shop from Sales to Rental: Shop has ${salesProductsCount} sales products and ${salesBillsCount} sales bills. Business type can only be changed to Rental when there are zero sales products and zero sales bills.`
          });
        }
      }

      // Rule 3: RENTAL -> SALES only allowed if 0 rental products and 0 rental bookings
      if (existingTenant.businessType === 'RENTAL' && targetBusinessType === 'SALES') {
        const [rentalProductsCount, rentalBookingsCount] = await Promise.all([
          prisma.product.count({
            where: {
              tenantId: existingTenant.id,
              availabilityType: { in: ['rent', 'both'] }
            }
          }),
          prisma.booking.count({
            where: { tenantId: existingTenant.id }
          })
        ]);

        if (rentalProductsCount > 0 || rentalBookingsCount > 0) {
          return res.status(400).json({
            status: 'error',
            code: 'BUSINESS_TYPE_CHANGE_BLOCKED',
            message: `Cannot change shop from Rental to Sales: Shop has ${rentalProductsCount} rental products and ${rentalBookingsCount} rental bookings. Business type can only be changed to Sales when there are zero rental products and zero rental bookings.`
          });
        }
      }
    }

    const parsedMaxProducts = parseLimitInput(max_products !== undefined ? max_products : maxProducts);
    const parsedMaxBookings = parseLimitInput(max_bookings !== undefined ? max_bookings : maxBookings);
    const parsedMaxSales = parseLimitInput(max_sales !== undefined ? max_sales : maxSales);

    const effectiveCompanyName = company_name !== undefined ? company_name : companyName;
    const effectivePhone = phone_number !== undefined ? phone_number : phone;
    const effectiveGst = gst_number !== undefined ? gst_number : gstNumber;
    const effectivePageTitle = page_title !== undefined ? page_title : pageTitle;

    // 4. TRACK MEANINGFUL PROFILE/SHOP CHANGES (Excluding status and password)
    const updatedFields = [];
    if (name !== undefined && name.trim() && name.trim() !== (existingTenant.name || '')) {
      updatedFields.push('Shop Name');
    }
    if (targetBusinessType !== undefined && targetBusinessType !== existingTenant.businessType) {
      updatedFields.push('Business Type');
    }
    if (parsedMaxProducts !== undefined && parsedMaxProducts !== existingTenant.maxProducts) {
      updatedFields.push('Product Limit');
    }
    if (parsedMaxBookings !== undefined && parsedMaxBookings !== existingTenant.maxBookings) {
      updatedFields.push('Booking Limit');
    }
    if (parsedMaxSales !== undefined && parsedMaxSales !== existingTenant.maxSales) {
      updatedFields.push('Sales Limit');
    }
    if (effectiveCompanyName !== undefined && effectiveCompanyName.trim() !== (existingTenant.settings?.companyName || '')) {
      updatedFields.push('Company Name');
    }
    if (effectivePageTitle !== undefined && effectivePageTitle.trim() !== (existingTenant.settings?.pageTitle || '')) {
      updatedFields.push('Page Title');
    }
    if (
      effectivePhone !== undefined &&
      String(effectivePhone).replace(/\D/g, '') !== String(existingTenant.settings?.phoneNumber || '').replace(/\D/g, '')
    ) {
      updatedFields.push('Phone Number');
    }
    if (address !== undefined && address.trim() !== (existingTenant.settings?.address || '')) {
      updatedFields.push('Address');
    }
    if (currency !== undefined && currency.trim() !== (existingTenant.settings?.currency || '')) {
      updatedFields.push('Currency');
    }
    if (logo_url !== undefined && logo_url !== (existingTenant.settings?.logoUrl || '')) {
      updatedFields.push('Store Logo');
    }
    if (effectiveGst !== undefined && effectiveGst.trim() !== (existingTenant.settings?.gstNumber || '')) {
      updatedFields.push('GST Number');
    }
    if (
      existingOwner &&
      owner_full_name !== undefined &&
      owner_full_name.trim() &&
      owner_full_name.trim() !== (existingOwner.fullName || '')
    ) {
      updatedFields.push('Owner Full Name');
    }

    let newPasswordHash = null;
    if (owner_password && String(owner_password).trim()) {
      newPasswordHash = await bcrypt.hash(String(owner_password).trim(), 10);
    }

    // 5. Update tenant & related tables in transaction
    const updatedTenant = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.update({
        where: { slug },
        data: {
          name: name !== undefined ? name : undefined,
          businessType: targetBusinessType !== undefined ? targetBusinessType : undefined,
          status: status !== undefined ? status : undefined,
          maxProducts: parsedMaxProducts !== undefined ? parsedMaxProducts : undefined,
          maxBookings: parsedMaxBookings !== undefined ? parsedMaxBookings : undefined,
          maxSales: parsedMaxSales !== undefined ? parsedMaxSales : undefined,
          updatedAt: new Date()
        }
      });

      if (
        effectiveCompanyName !== undefined ||
        effectivePhone !== undefined ||
        address !== undefined ||
        effectiveGst !== undefined ||
        currency !== undefined ||
        logo_url !== undefined ||
        effectivePageTitle !== undefined
      ) {
        await tx.setting.updateMany({
          where: { tenantId: tenant.id },
          data: {
            companyName: effectiveCompanyName !== undefined ? effectiveCompanyName : undefined,
            pageTitle: effectivePageTitle !== undefined ? effectivePageTitle : undefined,
            phoneNumber: effectivePhone !== undefined ? effectivePhone : undefined,
            address: address !== undefined ? address : undefined,
            currency: currency !== undefined ? currency : undefined,
            logoUrl: logo_url !== undefined ? logo_url : undefined,
            gstNumber: effectiveGst !== undefined ? effectiveGst : undefined,
            updatedAt: new Date()
          }
        });
      }

      if (existingOwner && (owner_full_name || newPasswordHash)) {
        await tx.user.update({
          where: { id: existingOwner.id },
          data: {
            fullName: owner_full_name ? owner_full_name.trim() : undefined,
            passwordHash: newPasswordHash || undefined,
            updatedAt: new Date()
          }
        });
      }

      return tenant;
    });

    // Delete the previous logo from storage when it is cleared or replaced.
    if (logo_url !== undefined && logo_url !== (existingTenant.settings?.logoUrl || '') && existingTenant.settings?.logoUrl) {
      await storageService.deleteRemoved(existingTenant.settings.logoUrl, logo_url);
    }

    // 5. Check if status transitioned to 'suspended'
    const statusChangedToSuspended = status === 'suspended' && existingTenant.status !== 'suspended';
    if (statusChangedToSuspended && existingOwner?.email) {
      const suspensionHtml = buildAccountSuspendedHtml({
        shopName: updatedTenant.name,
        ownerName: existingOwner.fullName,
        reason: reason || 'Administrative Review',
        customReason: customReason || '',
        supportUrl: emailLinksForRequest(req).supportUrl
      });
      await sendEmail({
        tenantId: updatedTenant.id,
        to: existingOwner.email,
        subject: 'Your Account Has Been Suspended',
        html: suspensionHtml,
        templateName: 'account_suspended',
        metadata: { reason, customReason, admin_email: req.user?.email }
      }).catch((err) => console.error('[Admin] Suspension email failed:', err.message));
    }

    // 6. Trigger general account update notification
    if (updatedFields.length > 0 && existingOwner?.email && !statusChangedToSuspended) {
      const updateHtml = buildAccountUpdatedHtml({
        shopName: updatedTenant.name,
        ownerName: existingOwner.fullName,
        updatedFields
      });
      await sendEmail({
        tenantId: updatedTenant.id,
        to: existingOwner.email,
        subject: 'KapadKart — Important: Your Account Information Was Updated',
        html: updateHtml,
        templateName: 'account_updated',
        metadata: { updated_fields: updatedFields, admin_email: req.user?.email }
      }).catch((err) => console.error('[Admin] Account update email failed:', err.message));
    }

    res.status(200).json({
      status: 'success',
      message: 'Tenant updated successfully',
      data: {
        id: updatedTenant.id,
        slug: updatedTenant.slug,
        original_slug: updatedTenant.originalSlug,
        name: updatedTenant.name,
        business_type: updatedTenant.businessType,
        businessType: updatedTenant.businessType,
        max_products: updatedTenant.maxProducts,
        max_bookings: updatedTenant.maxBookings,
        max_sales: updatedTenant.maxSales,
        maxProducts: updatedTenant.maxProducts,
        maxBookings: updatedTenant.maxBookings,
        maxSales: updatedTenant.maxSales,
        status: updatedTenant.status,
        created_by: updatedTenant.createdBy,
        created_by_admin_id: updatedTenant.createdByAdminId,
        created_at: updatedTenant.createdAt,
        updated_at: updatedTenant.updatedAt,
        updatedFields
      }
    });
  } catch (error) {
    next(error);
  }
};

router.put('/tenants/:slug', handleUpdateTenant);
router.put('/:slug', handleUpdateTenant);

/**
 * Helper: Archive tenant slug and users email upon soft-deletion
 */
const archiveTenantSlugAndEmails = async (tenant) => {
  const originalSlug = tenant.originalSlug || tenant.original_slug || tenant.slug;
  const timestamp = Date.now();
  const archivedSlug = `${originalSlug}-deleted-${timestamp}`;

  return await prisma.$transaction(async (tx) => {
    const updatedTenant = await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        slug: archivedSlug,
        originalSlug: originalSlug,
        status: 'deleted',
        updatedAt: new Date()
      }
    });

    const users = await tx.user.findMany({
      where: { tenantId: tenant.id }
    });

    for (const u of users) {
      const origEmail = u.originalEmail || u.email;
      await tx.user.update({
        where: { id: u.id },
        data: {
          originalEmail: origEmail,
          email: `${u.email}-deleted-${timestamp}`,
          updatedAt: new Date()
        }
      });
    }

    return {
      id: updatedTenant.id,
      slug: updatedTenant.slug,
      original_slug: updatedTenant.originalSlug,
      name: updatedTenant.name,
      status: updatedTenant.status,
      business_type: updatedTenant.businessType,
      created_by: updatedTenant.createdBy,
      created_by_admin_id: updatedTenant.createdByAdminId,
      created_at: updatedTenant.createdAt,
      updated_at: updatedTenant.updatedAt
    };
  });
};

/**
 * Helper: Restore tenant slug and users email with collision check
 */
const restoreTenantSlugAndEmails = async (tenant) => {
  const targetSlug =
    tenant.originalSlug ||
    tenant.original_slug ||
    tenant.slug.replace(/-deleted-\d+$/, '');

  const conflict = await prisma.tenant.findFirst({
    where: {
      slug: targetSlug,
      id: { not: tenant.id }
    }
  });

  if (conflict) {
    const error = new Error(
      `Cannot restore shop: the slug "${targetSlug}" is already in use by another shop ("${conflict.name}").`
    );
    error.status = 409;
    error.code = 'SLUG_CONFLICT';
    throw error;
  }

  return await prisma.$transaction(async (tx) => {
    const updatedTenant = await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        slug: targetSlug,
        status: 'active',
        updatedAt: new Date()
      }
    });

    const users = await tx.user.findMany({
      where: {
        tenantId: tenant.id,
        originalEmail: { not: null }
      }
    });

    for (const u of users) {
      await tx.user.update({
        where: { id: u.id },
        data: {
          email: u.originalEmail,
          updatedAt: new Date()
        }
      });
    }

    return {
      id: updatedTenant.id,
      slug: updatedTenant.slug,
      original_slug: updatedTenant.originalSlug,
      name: updatedTenant.name,
      status: updatedTenant.status,
      business_type: updatedTenant.businessType,
      created_by: updatedTenant.createdBy,
      created_by_admin_id: updatedTenant.createdByAdminId,
      created_at: updatedTenant.createdAt,
      updated_at: updatedTenant.updatedAt
    };
  });
};

/**
 * PATCH Tenant Status
 */
const handlePatchStatus = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { status, reason, customReason } = req.body;

    if (!['active', 'suspended', 'deleted'].includes(status)) {
      return res.status(400).json({ status: 'error', message: 'Invalid status value' });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      include: {
        users: {
          orderBy: { createdAt: 'asc' },
          take: 1
        }
      }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    const previousStatus = tenant.status;
    const owner = tenant.users[0] || null;

    if (status === 'deleted') {
      const archivedTenant = await archiveTenantSlugAndEmails(tenant);
      return res.status(200).json({
        status: 'success',
        message: 'Tenant status updated to deleted and slug/email released',
        data: archivedTenant
      });
    }

    if (status === 'active' && previousStatus === 'deleted') {
      const restoredTenant = await restoreTenantSlugAndEmails(tenant);
      return res.status(200).json({
        status: 'success',
        message: 'Tenant status updated to active',
        data: restoredTenant
      });
    }

    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status,
        updatedAt: new Date()
      }
    });

    // If changing from non-suspended to suspended, dispatch suspension email
    if (status === 'suspended' && previousStatus !== 'suspended' && owner?.email) {
      const suspensionHtml = buildAccountSuspendedHtml({
        shopName: tenant.name,
        ownerName: owner.fullName,
        reason: reason || 'Administrative Review',
        customReason: customReason || '',
        supportUrl: emailLinksForRequest(req).supportUrl
      });

      await sendEmail({
        tenantId: tenant.id,
        to: owner.email,
        subject: 'Your Account Has Been Suspended',
        html: suspensionHtml,
        templateName: 'account_suspended',
        metadata: { reason, customReason, admin_email: req.user?.email }
      }).catch((emailErr) => {
        console.error('[Admin] Failed to send suspension email:', emailErr.message);
      });
    }

    res.status(200).json({
      status: 'success',
      message: `Tenant status updated to ${status}`,
      data: {
        id: updated.id,
        slug: updated.slug,
        original_slug: updated.originalSlug,
        name: updated.name,
        business_type: updated.businessType,
        status: updated.status,
        created_by: updated.createdBy,
        created_by_admin_id: updated.createdByAdminId,
        created_at: updated.createdAt,
        updated_at: updated.updatedAt
      }
    });
  } catch (error) {
    if (error.code === 'SLUG_CONFLICT') {
      return res.status(409).json({
        status: 'error',
        code: 'SLUG_CONFLICT',
        message: error.message
      });
    }
    next(error);
  }
};

router.patch('/tenants/:slug/status', handlePatchStatus);
router.patch('/:slug/status', handlePatchStatus);

/**
 * DELETE Soft Delete Tenant
 */
const handleDeleteTenant = async (req, res, next) => {
  try {
    const { slug } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { slug }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    if (tenant.status === 'deleted') {
      return res.status(200).json({
        status: 'success',
        message: 'Tenant is already deleted',
        data: {
          id: tenant.id,
          slug: tenant.slug,
          original_slug: tenant.originalSlug,
          name: tenant.name,
          business_type: tenant.businessType,
          status: tenant.status
        }
      });
    }

    const archivedTenant = await archiveTenantSlugAndEmails(tenant);

    res.status(200).json({
      status: 'success',
      message: 'Tenant deleted successfully and slug/email released',
      data: archivedTenant
    });
  } catch (error) {
    next(error);
  }
};

router.delete('/tenants/:slug', handleDeleteTenant);
router.delete('/:slug', handleDeleteTenant);

/**
 * POST Restore Tenant
 */
const handleRestoreTenant = async (req, res, next) => {
  try {
    const { slug } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { slug }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    if (tenant.status !== 'deleted') {
      return res.status(400).json({ status: 'error', message: 'Tenant is not deleted' });
    }

    const restoredTenant = await restoreTenantSlugAndEmails(tenant);

    res.status(200).json({
      status: 'success',
      message: `Tenant "${restoredTenant.slug}" restored successfully`,
      data: restoredTenant
    });
  } catch (error) {
    if (error.code === 'SLUG_CONFLICT') {
      return res.status(409).json({
        status: 'error',
        code: 'SLUG_CONFLICT',
        message: error.message
      });
    }
    next(error);
  }
};

router.post('/tenants/:slug/restore', handleRestoreTenant);
router.post('/:slug/restore', handleRestoreTenant);

/**
 * POST /tenants/:slug/uploads/branding
 * Upload tenant branding logo from Admin side using tenant auth_key
 */
const handleTenantUploadBranding = async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No image file uploaded' });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, authKey: true }
    });

    if (!tenant) {
      return res.status(404).json({ status: 'error', message: 'Tenant not found' });
    }

    const prevSetting = await prisma.setting.findFirst({
      where: { tenantId: tenant.id }
    });

    const result = await storageService.upload({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
      folder: 'branding',
      authKey: tenant.authKey
    });

    // Update settings logo_url for tenant
    await prisma.setting.updateMany({
      where: { tenantId: tenant.id },
      data: {
        logoUrl: result.url,
        updatedAt: new Date()
      }
    });

    if (prevSetting?.logoUrl && prevSetting.logoUrl !== result.url) {
      await storageService.deleteRemoved(prevSetting.logoUrl, result.url);
    }

    res.status(200).json({
      status: 'success',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

router.post('/tenants/:slug/uploads/branding', uploadSingleImage, handleTenantUploadBranding);
router.post('/:slug/uploads/branding', uploadSingleImage, handleTenantUploadBranding);

/**
 * GET /logs
 * Retrieve platform audit and email logs
 */
router.get('/logs', async (req, res, next) => {
  try {
    const [activityLogs, emailLogs] = await Promise.all([
      prisma.activityLog.findMany({
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: {
          tenant: {
            select: { name: true }
          }
        }
      }),
      prisma.emailLog.findMany({
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: {
          tenant: {
            select: { name: true }
          }
        }
      })
    ]);

    const formattedActivity = activityLogs.map((a) => ({
      id: a.id,
      tenant_id: a.tenantId,
      user_id: a.userId,
      user_email: a.userEmail,
      user_name: a.userName,
      action: a.action,
      entity_type: a.entityType,
      entity_id: a.entityId,
      summary: a.summary,
      metadata: a.metadata,
      created_at: a.createdAt,
      tenant_name: a.tenant?.name || null
    }));

    const formattedEmails = emailLogs.map((e) => ({
      id: e.id,
      tenant_id: e.tenantId,
      provider: e.provider,
      from_address: e.fromAddress,
      to_address: e.toAddress,
      subject: e.subject,
      template_name: e.templateName,
      status: e.status,
      message_id: e.messageId,
      error_message: e.errorMessage,
      metadata: e.metadata,
      sent_at: e.sentAt,
      created_at: e.createdAt,
      tenant_name: e.tenant?.name || null
    }));

    res.status(200).json({
      status: 'success',
      data: {
        activityLogs: formattedActivity,
        emailLogs: formattedEmails
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
