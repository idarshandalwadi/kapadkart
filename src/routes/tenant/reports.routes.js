import { Router } from "express";
import { prisma } from "../../config/prisma.js";
import { formatActivityLog } from "../../services/activity/activityService.js";
import { formatRentalHistoryBooking, queryReturnsSchedule } from "./tenant.helpers.js";

const router = Router();

/**
 * Sales Reports (Rental Analytics, Revenue Chart & Bookings History)
 */
router.get('/sales-reports', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const chartDays = Math.min(365, Math.max(1, parseInt(req.query.chart_days, 10) || 7));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const status = req.query.status ? String(req.query.status).trim() : '';
    const from = req.query.from ? String(req.query.from).trim() : '';
    const to = req.query.to ? String(req.query.to).trim() : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const sortByParam = req.query.sort_by ? String(req.query.sort_by).trim() : 'bill_no';
    const sortOrder = req.query.sort_order === 'asc' ? 'asc' : 'desc';

    // 1. Quick Stats aggregations
    const [
      revenueAgg,
      paidAgg,
      dueAgg,
      completedCount,
      activeCount,
      bookingItemsAgg
    ] = await Promise.all([
      prisma.booking.aggregate({
        where: { tenantId, status: { notIn: ['cancelled', 'CANCELLED'] } },
        _sum: { rentalTotal: true }
      }),
      prisma.booking.aggregate({
        where: { tenantId, status: { notIn: ['cancelled', 'CANCELLED'] } },
        _sum: { paidAmount: true }
      }),
      prisma.booking.aggregate({
        where: { tenantId, status: { notIn: ['cancelled', 'CANCELLED'] } },
        _sum: { dueAmount: true }
      }),
      prisma.booking.count({
        where: { tenantId, status: { in: ['returned', 'completed', 'RETURNED', 'COMPLETED'] } }
      }),
      prisma.booking.count({
        where: { tenantId, status: { in: ['booked', 'dispatched', 'sent', 'partially_returned', 'BOOKED', 'DISPATCHED', 'SENT', 'PARTIALLY_RETURNED'] } }
      }),
      prisma.bookingItem.aggregate({
        where: {
          tenantId,
          booking: { status: { notIn: ['cancelled', 'CANCELLED'] } }
        },
        _sum: { quantity: true }
      })
    ]);

    const quickStats = {
      totalRevenueCompleted: Number(revenueAgg._sum?.rentalTotal || 0),
      totalPaidAmount: Number(paidAgg._sum?.paidAmount || 0),
      totalDueAmount: Number(dueAgg._sum?.dueAmount || 0),
      totalProductsHandled: Number(bookingItemsAgg._sum?.quantity || 0),
      completedBookings: completedCount,
      reservedActiveBookings: activeCount
    };

    // 2. Revenue Chart daily buckets
    const now = new Date();
    const days = [];
    for (let i = chartDays - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
      const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      days.push({ startOfDay, endOfDay, label });
    }

    const chartStartDate = days[0].startOfDay;
    const chartEndDate = days[days.length - 1].endOfDay;

    const periodBookings = await prisma.booking.findMany({
      where: {
        tenantId,
        status: { notIn: ['cancelled', 'CANCELLED'] },
        OR: [
          { pickupDate: { gte: chartStartDate, lte: chartEndDate } },
          { createdAt: { gte: chartStartDate, lte: chartEndDate } }
        ]
      },
      select: {
        createdAt: true,
        pickupDate: true,
        rentalTotal: true,
        paidAmount: true,
        dueAmount: true
      }
    });

    const dayBuckets = [];
    for (const day of days) {
      let paidAmount = 0;
      let dueAmount = 0;
      let totalAmount = 0;
      let bookingCount = 0;

      for (const b of periodBookings) {
        const targetDate = b.pickupDate || b.createdAt;
        const bTime = new Date(targetDate).getTime();
        if (bTime >= day.startOfDay.getTime() && bTime <= day.endOfDay.getTime()) {
          const tot = Number(b.rentalTotal || 0);
          const pd = Number(b.paidAmount || 0);
          const due = Number(b.dueAmount || 0);
          totalAmount += tot;
          paidAmount += pd;
          dueAmount += due;
          bookingCount += 1;
        }
      }

      dayBuckets.push({
        label: day.label,
        paidAmount,
        dueAmount,
        totalAmount,
        amount: paidAmount,
        bookings: bookingCount
      });
    }

    // 3. Bookings History Table with search, date range, sort, pagination
    const where = { tenantId };
    if (status && status !== 'all') {
      where.status = { equals: status, mode: 'insensitive' };
    }
    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: 'insensitive' } },
        { billNo: { contains: search, mode: 'insensitive' } },
        { phoneNumber: { contains: search, mode: 'insensitive' } },
        { villageAddress: { contains: search, mode: 'insensitive' } },
        { bookingItems: { some: { product: { productName: { contains: search, mode: 'insensitive' } } } } },
        { bookingItems: { some: { product: { productCode: { contains: search, mode: 'insensitive' } } } } }
      ];
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    let orderBy = { createdAt: 'desc' };
    if (sortByParam === 'bill_no') {
      orderBy = { billNo: sortOrder };
    } else if (sortByParam === 'name') {
      orderBy = { customerName: sortOrder };
    } else if (sortByParam === 'village') {
      orderBy = { villageAddress: sortOrder };
    } else if (sortByParam === 'order_date') {
      orderBy = { pickupDate: sortOrder };
    } else if (sortByParam === 'return_date') {
      orderBy = { returnDate: sortOrder };
    } else if (sortByParam === 'paid_amount') {
      orderBy = { paidAmount: sortOrder };
    } else if (sortByParam === 'due_amount') {
      orderBy = { dueAmount: sortOrder };
    } else if (sortByParam === 'grand_total') {
      orderBy = { rentalTotal: sortOrder };
    } else if (sortByParam === 'createdAt') {
      orderBy = { createdAt: sortOrder };
    }

    const [totalCount, historyBookings] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        include: {
          bookingItems: {
            include: {
              product: true,
              returns: true
            }
          }
        },
        orderBy,
        skip,
        take: limit
      })
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        quickStats,
        revenueChart: {
          title: 'Rental Revenue',
          subtitle: `Daily rental revenue breakdown over the last ${chartDays} days`,
          days: dayBuckets
        },
        bookingsHistory: {
          data: historyBookings.map(formatRentalHistoryBooking),
          pagination: {
            page,
            limit,
            total: totalCount,
            totalPages: Math.max(1, Math.ceil(totalCount / limit))
          },
          sort: {
            sortBy: sortByParam,
            sortOrder
          }
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/returns-schedule', async (req, res, next) => {
  try {
    const result = await queryReturnsSchedule(prisma, req.tenantId, req.query);
    res.status(200).json({
      status: 'success',
      data: result.data,
      total: result.total,
      tab: result.tab
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/activity
 * Query immutable audit activity logs for the authenticated tenant.
 */
router.get('/activity', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const { action, entity_type, from, to, search } = req.query;

    const where = {
      tenantId
    };

    if (action && action.trim()) {
      where.action = action.trim();
    }

    if (entity_type && entity_type.trim()) {
      where.entityType = entity_type.trim();
    }

    if (from || to) {
      where.createdAt = {};
      if (from) {
        where.createdAt.gte = new Date(from);
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    if (search && search.trim()) {
      const term = search.trim();
      where.OR = [
        { summary: { contains: term, mode: 'insensitive' } },
        { userEmail: { contains: term, mode: 'insensitive' } },
        { userName: { contains: term, mode: 'insensitive' } },
        { ipAddress: { contains: term, mode: 'insensitive' } },
        { entityId: { contains: term, mode: 'insensitive' } },
        { requestId: { contains: term, mode: 'insensitive' } }
      ];
    }

    const [total, logs] = await Promise.all([
      prisma.activityLog.count({ where }),
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.status(200).json({
      status: 'success',
      data: logs.map(formatActivityLog),
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/activity/:id
 * Retrieve specific activity record with context
 */
router.get('/activity/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const log = await prisma.activityLog.findFirst({
      where: { id, tenantId }
    });

    if (!log) {
      return res.status(404).json({ status: 'error', message: 'Activity log not found' });
    }

    res.status(200).json({
      status: 'success',
      data: formatActivityLog(log)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/performance
 * Product Performance & ROI Analytics
 */
router.get('/performance', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const from = req.query.from;
    const to = req.query.to;
    const sortBy = req.query.sort_by || 'net_profit';
    const order = (req.query.order || req.query.sort_order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

    const where = { tenantId };
    if (search) {
      where.OR = [
        { productName: { contains: search, mode: 'insensitive' } },
        { productCode: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } }
      ];
    }

    const dateFilter = {};
    if (from || to) {
      if (from) dateFilter.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        dateFilter.lte = toDate;
      }
    }
    const hasDateFilter = Boolean(from || to);

    const products = await prisma.product.findMany({
      where,
      include: {
        bookingItems: {
          where: {
            isActive: true,
            ...(hasDateFilter ? { createdAt: dateFilter } : {}),
            booking: {
              status: { notIn: ['cancelled', 'CANCELLED'] }
            }
          },
          select: {
            id: true,
            quantity: true,
            rentalDays: true,
            unitRent: true,
            totalAmount: true
          }
        },
        saleItems: {
          where: {
            ...(hasDateFilter ? { createdAt: dateFilter } : {}),
            sale: {
              status: { notIn: ['cancelled', 'CANCELLED'] }
            }
          },
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            purchasePrice: true,
            totalAmount: true
          }
        }
      }
    });

    const metrics = products.map((p) => {
      const purchasePrice = Number(p.purchasePrice || 0);
      const currentStock = Number(p.totalQuantity || 0);

      const unitsSold = (p.saleItems || []).reduce((acc, si) => acc + (si.quantity || 0), 0);
      const salesRevenue = (p.saleItems || []).reduce((acc, si) => acc + Number(si.totalAmount || 0), 0);

      const timesRented = (p.bookingItems || []).length;
      const rentalRevenue = (p.bookingItems || []).reduce((acc, bi) => acc + Number(bi.totalAmount || 0), 0);

      const totalPurchasedQuantity = currentStock + unitsSold;
      const investedAmount = purchasePrice * totalPurchasedQuantity;
      const totalRevenue = rentalRevenue + salesRevenue;
      const soldCost = purchasePrice * unitsSold;
      const netProfit = totalRevenue - soldCost;

      return {
        id: p.id,
        product_name: p.productName,
        product_code: p.productCode,
        category: p.category || 'General',
        image: p.image || null,
        purchase_price: purchasePrice,
        total_quantity: currentStock,
        units_sold: unitsSold,
        total_purchased_quantity: totalPurchasedQuantity,
        invested_amount: investedAmount,
        times_rented: timesRented,
        rental_revenue: rentalRevenue,
        sales_revenue: salesRevenue,
        total_revenue: totalRevenue,
        net_profit: netProfit,
        created_at: p.createdAt
      };
    });

    metrics.sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];

      if (sortBy === 'created_at') {
        valA = new Date(valA).getTime();
        valB = new Date(valB).getTime();
      } else {
        valA = Number(valA) || 0;
        valB = Number(valB) || 0;
      }

      if (order === 'asc') {
        return valA > valB ? 1 : valA < valB ? -1 : 0;
      }
      return valA < valB ? 1 : valA > valB ? -1 : 0;
    });

    const total = metrics.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const paginated = metrics.slice((page - 1) * limit, page * limit);

    res.status(200).json({
      status: 'success',
      data: paginated,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
