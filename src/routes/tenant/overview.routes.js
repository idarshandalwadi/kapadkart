import { Router } from 'express';
import { prisma } from '../../config/prisma.js';
import {
  bookingListViewWhere,
  istTodayRange
} from './tenant.helpers.js';

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
    const today = istTodayRange(now);
    const pickupWhere = { tenantId, ...bookingListViewWhere('pickup_today', now) };
    const dueTodayWhere = { tenantId, ...bookingListViewWhere('due_today', now) };
    const upcomingWhere = { tenantId, ...bookingListViewWhere('upcoming_delivery', now) };
    const overdueWhere = { tenantId, ...bookingListViewWhere('overdue', now) };
    const createdTodayWhere = { tenantId, ...bookingListViewWhere('created_today', now) };
    const outstandingWhere = { tenantId, ...bookingListViewWhere('outstanding', now) };
    const inHandWhere = {
      tenantId,
      status: { notIn: ['Discontinued', 'discontinued'] },
      totalQuantity: { gt: 0 }
    };

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
      prisma.product.count({ where: inHandWhere }),
      // Bookings total
      prisma.booking.count({ where: { tenantId } }),
      // Bookings currently out with the customer
      prisma.booking.count({
        where: { tenantId, status: { in: ['sent', 'partially_returned'] } }
      }),
      // Sales stats
      prisma.sale.aggregate({
        where: { tenantId, status: { not: 'cancelled' } },
        _count: true,
        _sum: { saleTotal: true }
      }),
      // Tenant settings for currency & store info
      prisma.setting.findFirst({ where: { tenantId } }),
      prisma.booking.count({ where: pickupWhere }),
      prisma.booking.count({ where: dueTodayWhere }),
      prisma.booking.count({ where: upcomingWhere }),
      prisma.booking.count({ where: overdueWhere }),
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
      prisma.sale.aggregate({
        where: {
          tenantId,
          status: { notIn: ['cancelled', 'CANCELLED'] },
          createdAt: { gte: today.gte, lte: today.lte }
        },
        _count: true,
        _sum: { saleTotal: true }
      }),
      prisma.booking.aggregate({
        where: createdTodayWhere,
        _sum: { paidAmount: true }
      }),
      prisma.booking.aggregate({
        where: outstandingWhere,
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

