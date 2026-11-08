import { Router } from 'express';
import { prisma } from '../../config/prisma.js';

const router = Router();

/**
 * Public tenant branding endpoint for web & PWA
 */
export const handlePublicTenantBranding = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const tenant = await prisma.tenant.findUnique({
      where: { slug: slug.toLowerCase() },
      include: { settings: true }
    });

    if (!tenant || tenant.status === 'deleted') {
      return res.status(404).json({ status: 'error', message: 'Shop not found' });
    }

    const brandingData = {
      slug: tenant.slug,
      name: tenant.name,
      business_type: tenant.businessType,
      max_products: tenant.maxProducts,
      max_bookings: tenant.maxBookings,
      max_sales: tenant.maxSales,
      status: tenant.status,
      company_name: tenant.settings?.companyName || tenant.name,
      page_title: tenant.settings?.pageTitle || tenant.settings?.companyName || tenant.name,
      phone_number: tenant.settings?.phoneNumber || '',
      address: tenant.settings?.address || '',
      currency: tenant.settings?.currency || 'INR',
      logo_url: tenant.settings?.logoUrl || '',
      favicon_url: tenant.settings?.faviconUrl || '',
      terms_and_conditions: tenant.settings?.termsAndConditions || ''
    };

    res.status(200).json({
      status: 'success',
      data: brandingData
    });
  } catch (error) {
    next(error);
  }
};

router.get('/tenants/:slug/branding', handlePublicTenantBranding);
router.get('/:slug/branding', handlePublicTenantBranding);

/**
 * GET /api/v1/tenant/overview and /api/v1/tenant/dashboard/summary
 * Live operational status, quotas, and business KPIs
 */
export const handleTenantOverview = async (req, res, next) => {
  try {
    const tenantId = req.tenantId;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const future15Days = new Date(startOfToday.getTime() + 15 * 24 * 60 * 60 * 1000);

    const [
      tenant,
      prodTotal,
      prodAvail,
      bookTotal,
      bookActive,
      salesAgg,
      setting,
      todayBookings,
      returnsDueToday,
      upcomingDeliveries,
      overdueRentals,
      recentBookings,
      todaySalesAgg,
      todayRentalRevAgg,
      outstandingAgg
    ] = await Promise.all([
      // Tenant info for quotas & business_type
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          businessType: true,
          maxProducts: true,
          maxBookings: true,
          maxSales: true
        }
      }),
      // Products total
      prisma.product.count({ where: { tenantId } }),
      // Products available
      prisma.product.count({ where: { tenantId, status: 'Available' } }),
      // Bookings total
      prisma.booking.count({ where: { tenantId } }),
      // Bookings active
      prisma.booking.count({ where: { tenantId, status: { in: ['confirmed', 'delivered'] } } }),
      // Sales stats
      prisma.sale.aggregate({
        where: { tenantId, status: { not: 'cancelled' } },
        _count: true,
        _sum: { saleTotal: true }
      }),
      // Tenant settings for currency & store info
      prisma.setting.findFirst({ where: { tenantId } }),
      // KPI 1: Pickups/Orders today
      prisma.booking.count({
        where: {
          tenantId,
          status: { notIn: ['cancelled', 'completed'] },
          pickupDate: { gte: startOfToday, lte: endOfToday }
        }
      }),
      // KPI 2: Returns expected today
      prisma.booking.count({
        where: {
          tenantId,
          status: { in: ['confirmed', 'delivered'] },
          returnDate: { gte: startOfToday, lte: endOfToday }
        }
      }),
      // KPI 3: Upcoming deliveries (next 15 days)
      prisma.booking.count({
        where: {
          tenantId,
          status: { notIn: ['cancelled', 'completed'] },
          pickupDate: { gt: endOfToday, lte: future15Days }
        }
      }),
      // KPI 4: Overdue rentals (return date in past, not yet returned)
      prisma.booking.count({
        where: {
          tenantId,
          status: { in: ['confirmed', 'delivered'] },
          returnDate: { lt: startOfToday }
        }
      }),
      // Recent active bookings preview
      prisma.booking.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          billNo: true,
          customerName: true,
          phoneNumber: true,
          status: true,
          rentalTotal: true,
          pickupDate: true,
          returnDate: true
        }
      }),
      // KPI 5: Today's direct sales revenue & count
      prisma.sale.aggregate({
        where: {
          tenantId,
          status: { notIn: ['cancelled'] },
          createdAt: { gte: startOfToday, lte: endOfToday }
        },
        _count: true,
        _sum: { saleTotal: true }
      }),
      // KPI 6 & 7: Today's rental cash inflow (paid bookings)
      prisma.booking.aggregate({
        where: {
          tenantId,
          status: { notIn: ['cancelled'] },
          createdAt: { gte: startOfToday, lte: endOfToday }
        },
        _sum: { paidAmount: true }
      }),
      // KPI 8: Total outstanding due (Baki)
      prisma.booking.aggregate({
        where: {
          tenantId,
          status: { notIn: ['cancelled'] }
        },
        _sum: { dueAmount: true }
      })
    ]);

    const businessType = tenant?.businessType || 'SALES_AND_RENTAL';

    const summaryData = {
      business_type: businessType,
      businessType,
      limits: {
        max_products: tenant?.maxProducts ?? null,
        max_bookings: tenant?.maxBookings ?? null,
        max_sales: tenant?.maxSales ?? null,
        maxProducts: tenant?.maxProducts ?? null,
        maxBookings: tenant?.maxBookings ?? null,
        maxSales: tenant?.maxSales ?? null
      },
      counts: {
        total_products: prodTotal,
        total_bookings: bookTotal,
        total_sales: salesAgg._count
      },
      products: { total: prodTotal, available: prodAvail },
      bookings: { total: bookTotal, active: bookActive },
      sales: { total: salesAgg._count, revenue: Number(salesAgg._sum.saleTotal || 0) },
      kpis: {
        today_bookings: todayBookings,
        returns_due_today: returnsDueToday,
        upcoming_deliveries: upcomingDeliveries,
        overdue_rentals: overdueRentals,
        completed_sales_count: todaySalesAgg._count || 0,
        today_sales_revenue: Number(todaySalesAgg._sum.saleTotal || 0),
        today_rental_revenue: Number(todayRentalRevAgg._sum.paidAmount || 0),
        total_outstanding_due: Number(outstandingAgg._sum.dueAmount || 0)
      },
      recentBookings: recentBookings.map((b) => ({
        id: b.id,
        bill_no: b.billNo,
        customer_name: b.customerName,
        phone_number: b.phoneNumber,
        status: b.status,
        rental_total: b.rentalTotal,
        pickup_date: b.pickupDate,
        return_date: b.returnDate
      })),
      settings: setting
        ? {
            company_name: setting.companyName,
            phone_number: setting.phoneNumber,
            currency: setting.currency,
            tax_rate: setting.taxRate
          }
        : {}
    };

    res.status(200).json({
      status: 'success',
      data: summaryData
    });
  } catch (error) {
    next(error);
  }
};

router.get('/overview', handleTenantOverview);
router.get('/dashboard/summary', handleTenantOverview);

export default router;

