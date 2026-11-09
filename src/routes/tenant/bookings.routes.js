import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { recordActivity } from "../../services/activity/activityService.js";
import {
  getProductStockInclude,
  formatProduct,
  formatBooking,
  generateNextTenantBillNo,
  queryReturnsSchedule,
  bookingListViewWhere,
  istCreatedAtRange
} from "./tenant.helpers.js";

const router = Router();

/**
 * GET /api/v1/tenant/bookings/next-bill-no
 */
router.get('/bookings/next-bill-no', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const billNo = await generateNextTenantBillNo(prisma, 'booking', tenantId, 'B');
    res.status(200).json({ status: 'success', data: { bill_no: billNo }, bill_no: billNo });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/bookings
 */
router.get('/bookings', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const status = req.query.status ? String(req.query.status).trim() : '';
    const tab = req.query.tab ? String(req.query.tab).trim().toLowerCase() : '';
    const from = req.query.from ? String(req.query.from).trim() : '';
    const to = req.query.to ? String(req.query.to).trim() : '';

    const now = new Date();
    const endOf6Days = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6, 23, 59, 59, 999);

    const where = { tenantId };

    if (tab === 'deliveries') {
      // Pickups & Deliveries due from today to next 6 days (including any overdue pickups)
      where.status = { equals: 'booked', mode: 'insensitive' };
      where.pickupDate = { lte: endOf6Days };
    } else if (tab === 'returns') {
      // Active rentals out with customer awaiting return
      where.status = { in: ['sent', 'partially_returned'] };
    } else if (tab === 'bookings') {
      // All advance reservations
      where.status = { equals: 'booked', mode: 'insensitive' };
    } else {
      const viewWhere = bookingListViewWhere(status);
      if (viewWhere) {
        Object.assign(where, viewWhere);
      } else if (status && status !== 'all') {
        where.status = { equals: status, mode: 'insensitive' };
      }
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

    if ((from || to) && status !== 'created_today') {
      const createdAt = istCreatedAtRange(from, to);
      if (createdAt) where.createdAt = createdAt;
    }

    // Determine sorting based on tab
    let orderBy = { createdAt: 'desc' };
    if (tab === 'deliveries') {
      orderBy = { pickupDate: 'asc' }; // Most urgent pickups first
    } else if (tab === 'returns') {
      orderBy = { returnDate: 'asc' }; // Overdue and urgent returns first
    } else if (tab === 'bookings') {
      orderBy = { pickupDate: 'asc' };
    }

    // Tab counts for quick overview badges
    const [countBookings, countDeliveries, countReturns, countAll, total, bookings] = await Promise.all([
      prisma.booking.count({ where: { tenantId, status: { equals: 'booked', mode: 'insensitive' } } }),
      prisma.booking.count({ where: { tenantId, status: { equals: 'booked', mode: 'insensitive' }, pickupDate: { lte: endOf6Days } } }),
      prisma.booking.count({ where: { tenantId, status: { in: ['sent', 'partially_returned'] } } }),
      prisma.booking.count({ where: { tenantId } }),
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
        orderBy
      })
    ]);

    res.status(200).json({
      status: 'success',
      data: bookings.map(formatBooking),
      total,
      tab_counts: {
        bookings: countBookings,
        deliveries: countDeliveries,
        returns: countReturns,
        all: countAll
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/bookings
 * Create a rental booking with overbooking protection transaction
 */
router.post('/bookings', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;

    const currentTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { maxBookings: true, businessType: true }
    });

    if (currentTenant?.businessType === 'SALES') {
      return res.status(400).json({
        status: 'error',
        message: 'Rental bookings are not supported for sales-only shops.'
      });
    }

    const {
      bill_no,
      customer_name,
      phone_number,
      extra_phone_number,
      village_address = '-',
      pickup_date,
      return_date,
      rental_days = 1,
      items = [],
      security_deposit = 0,
      deposit_paid = false,
      accessories_price = 0,
      discount_amount = 0,
      tax_rate = 0,
      tax_amount = 0,
      paid_amount = 0,
      notes = ''
    } = req.body;

    if (!customer_name || !phone_number || !pickup_date || !return_date || items.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Missing required booking details or item list' });
    }

    const invalidBookingItem = items.some((item) => {
      const price = Number(item.unit_rent);
      const qty = Number(item.quantity);
      return !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 1;
    });
    if (invalidBookingItem) {
      return res.status(400).json({
        status: 'error',
        success: false,
        code: 'INVALID_ITEM_PRICE',
        message: 'Each booking item must have a quantity of at least 1 and a rental price greater than 0.',
        fieldErrors: {
          items: 'Each booking item must have a quantity of at least 1 and a rental price greater than 0.'
        }
      });
    }

    const calculatedRentalTotal = items.reduce(
      (sum, item) =>
        sum +
        (parseFloat(item.total_amount) ||
          parseFloat(item.unit_rent || 0) * (item.rental_days || 1) * (item.quantity || 1)),
      0
    );

    if (!Number.isFinite(calculatedRentalTotal) || calculatedRentalTotal <= 0) {
      return res.status(400).json({
        status: 'error',
        success: false,
        code: 'INVALID_TOTAL',
        message: 'Booking rental total must be greater than 0.'
      });
    }

    const paidAmountNum = Number(paid_amount);
    if (!Number.isFinite(paidAmountNum) || paidAmountNum <= 0) {
      return res.status(400).json({
        status: 'error',
        success: false,
        code: 'INVALID_PAID_AMOUNT',
        message: 'Advance rent paid (Jama) is required and must be greater than 0 at booking creation.',
        fieldErrors: {
          paid_amount: 'Advance rent paid (Jama) is required and must be greater than 0.'
        }
      });
    }

    const secDepositNum = Number(security_deposit);
    if (!Number.isFinite(secDepositNum) || secDepositNum < 0) {
      return res.status(400).json({
        status: 'error',
        success: false,
        code: 'INVALID_DEPOSIT',
        message: 'Deposit amount must be 0 or greater.',
        fieldErrors: {
          security_deposit: 'Deposit amount must be 0 or greater.'
        }
      });
    }

    const booking = await prisma.$transaction(async (tx) => {
      // 0. Ensure unique sequential bill number per tenant (starts at B-0000001)
      let finalBillNo = bill_no ? String(bill_no).trim() : '';
      if (!finalBillNo) {
        finalBillNo = await generateNextTenantBillNo(tx, 'booking', tenantId, 'B');
      } else {
        const existingBill = await tx.booking.findFirst({
          where: { tenantId, billNo: finalBillNo },
          select: { id: true }
        });
        if (existingBill) {
          finalBillNo = await generateNextTenantBillNo(tx, 'booking', tenantId, 'B');
        }
      }
      // 1. Enforce Booking Quota Limit
      if (currentTenant?.maxBookings !== null && currentTenant?.maxBookings !== undefined) {
        const bookingCount = await tx.booking.count({ where: { tenantId } });
        if (bookingCount >= currentTenant.maxBookings) {
          const limitErr = new Error(`Booking limit reached (${currentTenant.maxBookings}). Your shop has reached its booking limit. Contact your administrator if you need additional capacity.`);
          limitErr.statusCode = 403;
          limitErr.code = 'BOOKING_LIMIT_REACHED';
          limitErr.details = { resource: 'bookings', limit: currentTenant.maxBookings, current: bookingCount };
          throw limitErr;
        }
      }

      // Overbooking Protection check for each item
      for (const item of items) {
        const { product_id, quantity = 1 } = item;

        // 1. Lock product row using raw SQL for update
        const prods = await tx.$queryRaw`
          SELECT id, product_name, total_quantity 
          FROM app.products 
          WHERE id = ${product_id}::uuid AND tenant_id = ${tenantId}::uuid 
          FOR UPDATE;
        `;

        if (!prods || prods.length === 0) {
          throw new Error(`Product ${product_id} not found.`);
        }

        const prod = prods[0];

        // 2. Calculate peak usage during requested date series using generate_series
        const conflictRes = await tx.$queryRaw`
          SELECT COALESCE(MAX(used), 0) AS max_used
          FROM (
            SELECT SUM(bi.quantity) AS used
            FROM generate_series(${pickup_date}::date, ${return_date}::date, interval '1 day') AS d(day)
            JOIN app.booking_items bi
              ON bi.tenant_id = ${tenantId}::uuid
             AND bi.product_id = ${product_id}::uuid
             AND bi.is_active = true
             AND d.day::date BETWEEN bi.block_start AND bi.block_end
            GROUP BY d.day
          ) t;
        `;

        const maxUsed = parseInt(conflictRes[0]?.max_used || 0, 10);
        if (maxUsed + quantity > prod.total_quantity) {
          const available = Math.max(0, prod.total_quantity - maxUsed);
          throw new Error(
            `Overbooking Conflict: Product "${prod.product_name}" only has ${available} available between ${pickup_date} and ${return_date} (requested: ${quantity}).`
          );
        }
      }

      // Calculate totals
      const itemsSubtotal = items.reduce(
        (sum, item) =>
          sum +
          (parseFloat(item.total_amount) ||
            parseFloat(item.unit_rent || 0) * (item.rental_days || 1) * (item.quantity || 1)),
        0
      );
      const accessoriesPriceVal = Math.max(0, parseFloat(accessories_price) || 0);
      const discountVal = Math.max(0, parseFloat(discount_amount) || 0);
      const taxRateVal = Math.max(0, parseFloat(tax_rate) || 0);
      const taxable = Math.max(0, itemsSubtotal + accessoriesPriceVal - discountVal);
      const taxAmountVal = tax_amount !== undefined && tax_amount !== null
        ? Math.max(0, parseFloat(tax_amount) || 0)
        : Math.round((taxable * taxRateVal / 100) * 100) / 100;
      const rentalTotal = Math.round((taxable + taxAmountVal) * 100) / 100;
      const paidVal = Math.max(0, parseFloat(paid_amount) || 0);
      const dueAmount = Math.max(0, rentalTotal - paidVal);

      const isDepositPaid = deposit_paid === true || deposit_paid === 'true' || deposit_paid === 1 || deposit_paid === '1';
      const secDepositVal = Math.max(0, parseFloat(security_deposit) || 0);

      // Insert booking
      const createdBooking = await tx.booking.create({
        data: {
          tenantId,
          billNo: finalBillNo,
          customerName: customer_name,
          phoneNumber: phone_number,
          extraPhoneNumber: extra_phone_number || null,
          villageAddress: village_address,
          pickupDate: new Date(pickup_date),
          returnDate: new Date(return_date),
          rentalDays: parseInt(rental_days, 10) || 1,
          securityDeposit: secDepositVal,
          depositPaid: isDepositPaid,
          accessoriesPrice: accessoriesPriceVal,
          discountAmount: discountVal,
          taxRate: taxRateVal,
          taxAmount: taxAmountVal,
          rentalTotal,
          paidAmount: paidVal,
          dueAmount,
          notes,
          status: 'booked'
        }
      });

      // Insert line items with blocked availability dates
      for (const item of items) {
        const itemAccessories = (item.accessories && typeof item.accessories === 'object')
          ? item.accessories
          : {
              choyani: item.choyani || null,
              pant: item.pant || null,
              sol: item.sol || null,
              mojdi: item.mojdi || null,
              other_items: item.other_items || item.otherItems || null
            };

        await tx.bookingItem.create({
          data: {
            tenantId,
            bookingId: createdBooking.id,
            productId: item.product_id,
            quantity: item.quantity || 1,
            unitRent: item.unit_rent || 0,
            rentalDays: item.rental_days || 1,
            totalAmount: item.total_amount || 0,
            accessories: itemAccessories,
            blockStart: new Date(pickup_date),
            blockEnd: new Date(return_date),
            isActive: true,
            status: 'pending'
          }
        });
      }

      return await tx.booking.findFirst({
        where: { id: createdBooking.id },
        include: {
          bookingItems: {
            include: {
              product: true
            }
          }
        }
      });
    }, { maxWait: 10000, timeout: 25000 });

    recordActivity({
      tenantId,
      action: 'create',
      entityType: 'booking',
      entityId: booking.id,
      summary: `Created rental booking #${booking.billNo} for customer ${booking.customerName} (₹${booking.rentalTotal})`,
      changes: {
        bill_no: booking.billNo,
        customer_name: booking.customerName,
        phone_number: booking.phoneNumber,
        rental_total: booking.rentalTotal,
        paid_amount: booking.paidAmount,
        due_amount: booking.dueAmount,
        pickup_date: booking.pickupDate,
        return_date: booking.returnDate,
        items_count: items.length
      },
      req
    });

    res.status(201).json({ status: 'success', data: formatBooking(booking) });
  } catch (error) {
    res.status(error.statusCode || 400).json({
      status: 'error',
      success: false,
      code: error.code || 'BOOKING_CREATE_ERROR',
      message: error.message,
      details: error.details || null,
      fieldErrors: error.fieldErrors || null
    });
  }
});

/**
 * GET /api/v1/tenant/bookings/availability
 * Search rental items and compute availability over requested date window [pickup_date, return_date]
 */
router.get('/bookings/availability', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const size = req.query.size ? String(req.query.size).trim() : '';
    const category = req.query.category ? String(req.query.category).trim() : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const now = new Date();
    const defaultPickup = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
    const defaultReturn = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 21, 0, 0);

    const pickupDate = req.query.pickup_date && !Number.isNaN(new Date(req.query.pickup_date).getTime())
      ? new Date(req.query.pickup_date)
      : defaultPickup;

    const returnDate = req.query.return_date && !Number.isNaN(new Date(req.query.return_date).getTime())
      ? new Date(req.query.return_date)
      : defaultReturn;

    // Filter rentable products (rent or both)
    const productWhere = {
      tenantId,
      availabilityType: { in: ['rent', 'both'] }
    };

    if (search) {
      productWhere.OR = [
        { productName: { contains: search, mode: 'insensitive' } },
        { productCode: { contains: search, mode: 'insensitive' } }
      ];
    }

    if (size && size !== 'all') {
      productWhere.size = { equals: size, mode: 'insensitive' };
    }

    if (category && category !== 'all') {
      productWhere.category = { equals: category, mode: 'insensitive' };
    }

    const [total, products] = await Promise.all([
      prisma.product.count({ where: productWhere }),
      prisma.product.findMany({
        where: productWhere,
        skip,
        take: limit,
        orderBy: { productName: 'asc' },
        include: {
          bookingItems: {
            where: {
              isActive: true,
              booking: { status: { not: 'cancelled' } },
              blockStart: { lte: returnDate },
              blockEnd: { gte: pickupDate }
            },
            include: {
              booking: {
                select: {
                  id: true,
                  billNo: true,
                  customerName: true,
                  phoneNumber: true,
                  pickupDate: true,
                  returnDate: true,
                  status: true
                }
              }
            }
          }
        }
      })
    ]);

    const items = products.map((prod) => {
      const inStock = Math.max(0, Number(prod.totalQuantity) || 0);
      const damaged = Number(prod.damagedQuantity) || 0;

      const activeBookings = (prod.bookingItems || []).map((bi) => ({
        booking_id: bi.booking?.id,
        bill_no: bi.booking?.billNo,
        customer_name: bi.booking?.customerName,
        phone_number: bi.booking?.phoneNumber,
        quantity: bi.quantity,
        pickup_date: bi.booking?.pickupDate || bi.blockStart,
        return_date: bi.booking?.returnDate || bi.blockEnd,
        status: bi.booking?.status || bi.status
      }));

      const totalBookedInWindow = activeBookings.reduce((sum, b) => sum + (Number(b.quantity) || 1), 0);
      const availableUnits = Math.max(0, inStock - damaged - totalBookedInWindow);

      return {
        id: prod.id,
        product_name: prod.productName,
        product_code: prod.productCode,
        size: prod.size,
        category: prod.category,
        brand: prod.brand,
        gender: prod.gender,
        daily_rent: prod.dailyRent,
        image: prod.image,
        total_quantity: inStock,
        damaged_quantity: damaged,
        booked_quantity: totalBookedInWindow,
        available_quantity: availableUnits,
        is_available: availableUnits > 0,
        conflicting_bookings: activeBookings
      };
    });

    res.status(200).json({
      status: 'success',
      data: items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      query: {
        search,
        size,
        pickup_date: pickupDate,
        return_date: returnDate
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/bookings/calendar
 * Fetch scheduled rental bookings for a calendar range (e.g. Month view)
 */
router.get('/bookings/calendar', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const productId = req.query.product_id ? String(req.query.product_id).trim() : null;
    const fromStr = req.query.from;
    const toStr = req.query.to;

    const now = new Date();
    const from = fromStr && !Number.isNaN(new Date(fromStr).getTime())
      ? new Date(fromStr)
      : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);

    const to = toStr && !Number.isNaN(new Date(toStr).getTime())
      ? new Date(toStr)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const itemWhere = {
      tenantId,
      isActive: true,
      booking: { status: { not: 'cancelled' } },
      blockStart: { lte: to },
      blockEnd: { gte: from }
    };

    const isUuid = typeof productId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId);
    if (productId && productId !== 'all' && isUuid) {
      itemWhere.productId = productId;
    }

    const bookingItems = await prisma.bookingItem.findMany({
      where: itemWhere,
      include: {
        product: {
          select: {
            id: true,
            productName: true,
            productCode: true,
            image: true,
            totalQuantity: true,
            dailyRent: true,
            size: true
          }
        },
        booking: {
          select: {
            id: true,
            billNo: true,
            customerName: true,
            phoneNumber: true,
            pickupDate: true,
            returnDate: true,
            rentalTotal: true,
            paidAmount: true,
            dueAmount: true,
            status: true
          }
        }
      },
      orderBy: {
        blockStart: 'asc'
      }
    });

    const events = bookingItems.map((bi) => ({
      id: bi.id,
      booking_id: bi.booking?.id,
      bill_no: bi.booking?.billNo,
      customer_name: bi.booking?.customerName,
      phone_number: bi.booking?.phoneNumber,
      product_id: bi.product?.id,
      product_name: bi.product?.productName,
      product_code: bi.product?.productCode,
      product_image: bi.product?.image,
      product_size: bi.product?.size,
      quantity: bi.quantity,
      unit_rent: bi.unitRent,
      total_amount: bi.totalAmount,
      status: bi.booking?.status || bi.status,
      start_date: bi.blockStart || bi.booking?.pickupDate,
      end_date: bi.blockEnd || bi.booking?.returnDate,
      rental_total: bi.booking?.rentalTotal,
      paid_amount: bi.booking?.paidAmount,
      due_amount: bi.booking?.dueAmount
    }));

    res.status(200).json({
      status: 'success',
      data: events,
      range: { from, to }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/bookings/returns-schedule
 * Dashboard tabs: overdue, today, tomorrow, upcoming.
 * Registered before /bookings/:id so "returns-schedule" is not queried as a UUID.
 */
router.get('/bookings/returns-schedule', async (req, res, next) => {
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
 * GET /api/v1/tenant/bookings/:id
 */
router.get('/bookings/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }
    const booking = await prisma.booking.findFirst({
      where: { id, tenantId },
      include: {
        bookingItems: {
          include: {
            product: true,
            returns: true
          }
        }
      }
    });

    if (!booking) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    res.status(200).json({ status: 'success', data: formatBooking(booking) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/bookings/:id/share-link
 * Generates an expiring public download link for a booking bill with images
 */
router.post('/bookings/:id/share-link', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const booking = await prisma.booking.findFirst({
      where: { id, tenantId }
    });

    if (!booking) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const ttlHours = parseInt(process.env.BILL_SHARE_TOKEN_TTL_HOURS || '72', 10);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const shareToken = await prisma.billShareToken.create({
      data: {
        token,
        type: 'booking',
        recordId: booking.id,
        tenantId,
        expiresAt
      }
    });

    res.status(200).json({
      status: 'success',
      data: {
        token: shareToken.token,
        download_path: `/api/v1/public/bills/download/${shareToken.token}`,
        expires_at: shareToken.expiresAt
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/tenant/bookings/:id
 * Update an existing rental booking with overbooking protection
 */
router.put('/bookings/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    const existingBooking = await prisma.booking.findFirst({
      where: { id, tenantId },
      include: { bookingItems: true }
    });

    if (!existingBooking) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    const lockedStatuses = ['returned', 'completed', 'cancelled'];
    if (lockedStatuses.includes(String(existingBooking.status || '').toLowerCase())) {
      return res.status(400).json({
        status: 'error',
        message: `Booking #${existingBooking.billNo} is ${existingBooking.status} and cannot be modified.`
      });
    }

    const {
      customer_name,
      phone_number,
      extra_phone_number,
      village_address,
      pickup_date,
      return_date,
      rental_days,
      items,
      security_deposit,
      deposit_paid,
      accessories_price,
      discount_amount,
      tax_rate,
      tax_amount,
      paid_amount,
      notes,
      status
    } = req.body;

    const updatedBooking = await prisma.$transaction(async (tx) => {
      // 1. If cancelling the booking
      if (status && status.toLowerCase() === 'cancelled') {
        await tx.bookingItem.updateMany({
          where: { bookingId: id, tenantId },
          data: { isActive: false }
        });
        return tx.booking.update({
          where: { id },
          data: { status: 'cancelled' },
          include: { bookingItems: { include: { product: true } } }
        });
      }

      const effectivePickup = pickup_date ? new Date(pickup_date) : existingBooking.pickupDate;
      const effectiveReturn = return_date ? new Date(return_date) : existingBooking.returnDate;

      const updateData = {};
      if (customer_name !== undefined) updateData.customerName = customer_name.trim();
      if (phone_number !== undefined) updateData.phoneNumber = phone_number.trim();
      if (extra_phone_number !== undefined) updateData.extraPhoneNumber = extra_phone_number ? extra_phone_number.trim() : null;
      if (village_address !== undefined) updateData.villageAddress = village_address ? village_address.trim() : '-';
      if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
      if (status !== undefined) updateData.status = status;
      if (pickup_date !== undefined) updateData.pickupDate = effectivePickup;
      if (return_date !== undefined) updateData.returnDate = effectiveReturn;
      if (rental_days !== undefined) updateData.rentalDays = parseInt(rental_days, 10) || 1;
      if (deposit_paid !== undefined) {
        updateData.depositPaid = deposit_paid === true || deposit_paid === 'true' || deposit_paid === 1 || deposit_paid === '1';
      }
      if (security_deposit !== undefined) {
        updateData.securityDeposit = Math.max(0, parseFloat(security_deposit) || 0);
      }

      if (items && Array.isArray(items) && items.length > 0) {
        // Validate items
        const invalidBookingItem = items.some((item) => {
          const price = Number(item.unit_rent);
          const qty = Number(item.quantity);
          return !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 1;
        });
        if (invalidBookingItem) {
          const itemErr = new Error('Each booking item must have a quantity of at least 1 and a rental price greater than 0.');
          itemErr.statusCode = 400;
          throw itemErr;
        }

        // Overbooking check for each item, excluding this booking's own reservations
        for (const item of items) {
          const { product_id, quantity = 1 } = item;

          const prods = await tx.$queryRaw`
            SELECT id, product_name, total_quantity 
            FROM app.products 
            WHERE id = ${product_id}::uuid AND tenant_id = ${tenantId}::uuid 
            FOR UPDATE;
          `;

          if (!prods || prods.length === 0) {
            throw new Error(`Product ${product_id} not found.`);
          }

          const prod = prods[0];

          const conflictRes = await tx.$queryRaw`
            SELECT COALESCE(MAX(used), 0) AS max_used
            FROM (
              SELECT SUM(bi.quantity) AS used
              FROM generate_series(${effectivePickup}::date, ${effectiveReturn}::date, interval '1 day') AS d(day)
              JOIN app.booking_items bi
                ON bi.tenant_id = ${tenantId}::uuid
               AND bi.product_id = ${product_id}::uuid
               AND bi.is_active = true
               AND bi.booking_id != ${id}::uuid
               AND d.day::date BETWEEN bi.block_start AND bi.block_end
              GROUP BY d.day
            ) t;
          `;

          const maxUsed = parseInt(conflictRes[0]?.max_used || 0, 10);
          if (maxUsed + quantity > prod.total_quantity) {
            const available = Math.max(0, prod.total_quantity - maxUsed);
            throw new Error(
              `Overbooking Conflict: Product "${prod.product_name}" only has ${available} available between ${effectivePickup.toISOString().slice(0, 10)} and ${effectiveReturn.toISOString().slice(0, 10)} (requested: ${quantity}).`
            );
          }
        }

        // Delete old items
        await tx.bookingItem.deleteMany({ where: { bookingId: id, tenantId } });

        // Calculate totals
        const itemsSubtotal = items.reduce(
          (sum, item) =>
            sum +
            (parseFloat(item.total_amount) ||
              parseFloat(item.unit_rent || 0) * (item.rental_days || updateData.rentalDays || existingBooking.rentalDays || 1) * (item.quantity || 1)),
          0
        );
        const accessoriesPriceVal = accessories_price !== undefined ? Math.max(0, parseFloat(accessories_price) || 0) : Number(existingBooking.accessoriesPrice || 0);
        const discountVal = discount_amount !== undefined ? Math.max(0, parseFloat(discount_amount) || 0) : Number(existingBooking.discountAmount || 0);
        const taxRateVal = tax_rate !== undefined ? Math.max(0, parseFloat(tax_rate) || 0) : Number(existingBooking.taxRate || 0);
        const taxable = Math.max(0, itemsSubtotal + accessoriesPriceVal - discountVal);
        const taxAmountVal = tax_amount !== undefined && tax_amount !== null
          ? Math.max(0, parseFloat(tax_amount) || 0)
          : Math.round((taxable * taxRateVal / 100) * 100) / 100;
        const rentalTotal = Math.round((taxable + taxAmountVal) * 100) / 100;
        const paidVal = paid_amount !== undefined ? Math.max(0, parseFloat(paid_amount) || 0) : Number(existingBooking.paidAmount || 0);
        const dueAmount = Math.max(0, rentalTotal - paidVal);

        updateData.accessoriesPrice = accessoriesPriceVal;
        updateData.discountAmount = discountVal;
        updateData.taxRate = taxRateVal;
        updateData.taxAmount = taxAmountVal;
        updateData.rentalTotal = rentalTotal;
        updateData.paidAmount = paidVal;
        updateData.dueAmount = dueAmount;

        // Insert updated items
        for (const item of items) {
          const itemAccessories = (item.accessories && typeof item.accessories === 'object')
            ? item.accessories
            : {
                choyani: item.choyani || null,
                pant: item.pant || null,
                sol: item.sol || null,
                mojdi: item.mojdi || null,
                other_items: item.other_items || item.otherItems || null
              };

          await tx.bookingItem.create({
            data: {
              tenantId,
              bookingId: id,
              productId: item.product_id,
              quantity: item.quantity || 1,
              unitRent: item.unit_rent || 0,
              rentalDays: item.rental_days || updateData.rentalDays || existingBooking.rentalDays || 1,
              totalAmount: item.total_amount || 0,
              accessories: itemAccessories,
              blockStart: effectivePickup,
              blockEnd: effectiveReturn,
              isActive: true,
              status: item.status || 'pending'
            }
          });
        }
      } else {
        // Just updating non-item fields
        if (accessories_price !== undefined) updateData.accessoriesPrice = Math.max(0, parseFloat(accessories_price) || 0);
        if (discount_amount !== undefined) updateData.discountAmount = Math.max(0, parseFloat(discount_amount) || 0);
        if (tax_rate !== undefined) updateData.taxRate = Math.max(0, parseFloat(tax_rate) || 0);
        if (tax_amount !== undefined) updateData.taxAmount = Math.max(0, parseFloat(tax_amount) || 0);
        if (paid_amount !== undefined) updateData.paidAmount = Math.max(0, parseFloat(paid_amount) || 0);
      }

      return tx.booking.update({
        where: { id },
        data: updateData,
        include: {
          bookingItems: {
            include: { product: true }
          }
        }
      });
    }, { maxWait: 10000, timeout: 25000 });

    recordActivity({
      tenantId,
      action: 'update',
      entityType: 'booking',
      entityId: id,
      summary: `Updated rental booking #${updatedBooking.billNo} for customer ${updatedBooking.customerName}`,
      req
    });

    res.status(200).json({ status: 'success', data: formatBooking(updatedBooking) });
  } catch (error) {
    res.status(error.statusCode || 400).json({
      status: 'error',
      success: false,
      code: error.code || 'BOOKING_UPDATE_ERROR',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/tenant/bookings/:id
 * Delete or cancel a rental booking
 */
router.delete('/bookings/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    const booking = await prisma.booking.findFirst({
      where: { id, tenantId }
    });

    if (!booking) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.bookingItem.deleteMany({ where: { bookingId: id, tenantId } });
      await tx.booking.delete({ where: { id } });
    });

    recordActivity({
      tenantId,
      action: 'delete',
      entityType: 'booking',
      entityId: id,
      summary: `Deleted rental booking #${booking.billNo} for ${booking.customerName}`,
      req
    });

    res.status(200).json({ status: 'success', message: `Deleted rental ${booking.billNo}` });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/bookings/:id/send
 * Dispatch & Handover a booking to the customer, optionally collecting rent and security deposit.
 */
router.post('/bookings/:id/send', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    const booking = await prisma.booking.findFirst({
      where: { id, tenantId },
      include: {
        bookingItems: {
          include: {
            product: true,
            returns: true
          }
        }
      }
    });

    if (!booking) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ status: 'error', message: 'Cannot dispatch a cancelled booking' });
    }

    if (booking.status === 'returned') {
      return res.status(400).json({ status: 'error', message: 'Booking is already marked as returned' });
    }

    const { payment } = req.body || {};
    const rentalPayment = payment?.rental_amount !== undefined ? Math.max(0, Number(payment.rental_amount) || 0) : 0;
    const depositPayment = payment?.deposit_amount !== undefined ? Math.max(0, Number(payment.deposit_amount) || 0) : 0;
    const paymentMethod = payment?.payment_method ? String(payment.payment_method).toUpperCase() : 'CASH';
    const paymentNotes = payment?.notes ? String(payment.notes).trim() : null;

    const currentPaid = Number(booking.paidAmount || 0);
    const currentRentalTotal = Number(booking.rentalTotal || 0);
    const newPaidAmount = Math.round((currentPaid + rentalPayment) * 100) / 100;
    const newDueAmount = Math.max(0, Math.round((currentRentalTotal - newPaidAmount) * 100) / 100);

    const currentDepositPaid = Boolean(booking.depositPaid);
    const newDepositPaid = currentDepositPaid || depositPayment > 0;

    const updatedBooking = await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id },
        data: {
          status: 'sent',
          paidAmount: newPaidAmount,
          dueAmount: newDueAmount,
          depositPaid: newDepositPaid,
          updatedAt: new Date()
        },
        include: {
          bookingItems: {
            include: {
              product: true,
              returns: true
            }
          }
        }
      });

      await tx.bookingItem.updateMany({
        where: { bookingId: id, tenantId },
        data: { status: 'sent', updatedAt: new Date() }
      });

      if (rentalPayment > 0) {
        await tx.payment.create({
          data: {
            tenantId,
            bookingId: id,
            amount: rentalPayment,
            paymentMethod,
            paymentType: newDueAmount === 0 ? 'FINAL' : 'PARTIAL',
            allocation: 'RENTAL',
            direction: 'INFLOW',
            notes: paymentNotes || `Rent collected at dispatch for booking #${booking.billNo}`,
            createdBy: req.user?.username || req.user?.email || 'tenant'
          }
        });
      }

      if (depositPayment > 0) {
        await tx.payment.create({
          data: {
            tenantId,
            bookingId: id,
            amount: depositPayment,
            paymentMethod,
            paymentType: 'DEPOSIT',
            allocation: 'SECURITY_DEPOSIT',
            direction: 'INFLOW',
            notes: paymentNotes || `Security deposit collected at dispatch for booking #${booking.billNo}`,
            createdBy: req.user?.username || req.user?.email || 'tenant'
          }
        });
      }

      return updated;
    });

    recordActivity({
      tenantId,
      action: 'update',
      entityType: 'booking',
      entityId: id,
      summary: `Dispatched & handed over booking #${booking.billNo} to ${booking.customerName}` +
        (rentalPayment > 0 || depositPayment > 0 ? ` (Collected Rent: ₹${rentalPayment}, Deposit: ₹${depositPayment})` : ''),
      req
    });

    res.status(200).json({
      status: 'success',
      message: `Booking #${booking.billNo} dispatched successfully`,
      data: formatBooking(updatedBooking)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/bookings/:id/return
 * Process garment returns, damage/late inspection, penalty calculation, deposit refund, and final settlement.
 */
router.post('/bookings/:id/return', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    const booking = await prisma.booking.findFirst({
      where: { id, tenantId },
      include: {
        bookingItems: {
          include: {
            product: true,
            returns: true
          }
        }
      }
    });

    if (!booking) {
      return res.status(404).json({ status: 'error', message: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ status: 'error', message: 'Cannot process return for a cancelled booking' });
    }

    const { items = [], notes: overallNotes, payment = {} } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ status: 'error', message: 'At least one item return must be provided' });
    }

    const directPayNow = Math.max(0, Number(payment.direct_payment_amount) || 0);
    const discountNow = Math.max(0, Number(payment.discount_amount) || 0);
    const payMethod = payment.payment_method ? String(payment.payment_method).toUpperCase() : 'CASH';

    const currentPaid = Number(booking.paidAmount || 0);
    const currentDiscount = Number(booking.discountAmount || 0);
    const currentRentalTotal = Number(booking.rentalTotal || 0);

    const updatedPaid = Math.round((currentPaid + directPayNow) * 100) / 100;
    const updatedDiscount = Math.round((currentDiscount + discountNow) * 100) / 100;
    const updatedDue = Math.max(0, Math.round((currentRentalTotal - updatedPaid - discountNow) * 100) / 100);

    const updatedBooking = await prisma.$transaction(async (tx) => {
      // 1. Record return items
      for (const item of items) {
        const retQty = Math.max(0, parseInt(item.returned_quantity, 10) || 0);
        if (retQty > 0) {
          await tx.bookingReturn.create({
            data: {
              tenantId,
              bookingItemId: item.booking_item_id,
              returnedQuantity: retQty,
              returnedAt: new Date(),
              status: (Number(item.damage_quantity) || 0) > 0 ? 'damaged' : 'returned',
              lateDays: Math.max(0, parseInt(item.late_days, 10) || 0),
              latePenalty: Math.max(0, Number(item.late_penalty) || 0),
              damageQuantity: Math.max(0, parseInt(item.damage_quantity, 10) || 0),
              damageAmount: Math.max(0, Number(item.damage_amount) || 0),
              otherPenalty: Math.max(0, Number(item.other_penalty) || 0),
              totalPenalty: Math.round(((Number(item.late_penalty) || 0) + (Number(item.damage_amount) || 0) + (Number(item.other_penalty) || 0)) * 100) / 100,
              notes: item.notes ? String(item.notes).trim() : null,
              createdBy: req.user?.username || req.user?.email || 'tenant'
            }
          });
        }
      }

      // 2. Check full vs partial return status
      const allReturns = await tx.bookingReturn.findMany({
        where: { tenantId, bookingItemId: { in: booking.bookingItems.map(b => b.id) } }
      });
      const itemReturnMap = {};
      for (const r of allReturns) {
        itemReturnMap[r.bookingItemId] = (itemReturnMap[r.bookingItemId] || 0) + r.returnedQuantity;
      }
      const allReturned = booking.bookingItems.every(bi => (itemReturnMap[bi.id] || 0) >= bi.quantity);
      const newStatus = allReturned ? 'returned' : 'partially_returned';

      // 3. Update booking items status if fully returned
      for (const bi of booking.bookingItems) {
        if ((itemReturnMap[bi.id] || 0) >= bi.quantity) {
          await tx.bookingItem.update({
            where: { id: bi.id },
            data: { status: 'returned', updatedAt: new Date() }
          });
        }
      }

      // 4. Update booking record
      const updatedNotes = overallNotes
        ? (booking.notes ? `${booking.notes}\n${overallNotes}` : overallNotes)
        : booking.notes;

      const updated = await tx.booking.update({
        where: { id },
        data: {
          status: newStatus,
          paidAmount: updatedPaid,
          discountAmount: updatedDiscount,
          dueAmount: updatedDue,
          notes: updatedNotes,
          updatedAt: new Date()
        },
        include: {
          bookingItems: {
            include: {
              product: true,
              returns: true
            }
          }
        }
      });

      // 5. Record settlement payment if direct payment was collected
      if (directPayNow > 0) {
        await tx.payment.create({
          data: {
            tenantId,
            bookingId: id,
            amount: directPayNow,
            paymentMethod: payMethod,
            paymentType: updatedDue === 0 ? 'FINAL' : 'PARTIAL',
            allocation: 'RENTAL',
            direction: 'INFLOW',
            notes: `Collected at return settlement for booking #${booking.billNo}`,
            createdBy: req.user?.username || req.user?.email || 'tenant'
          }
        });
      }

      return updated;
    });

    recordActivity({
      tenantId,
      action: 'update',
      entityType: 'booking',
      entityId: id,
      summary: `Processed return for booking #${booking.billNo} (${updatedBooking.status})`,
      req
    });

    res.status(200).json({
      status: 'success',
      message: `Return for booking #${booking.billNo} processed successfully`,
      data: formatBooking(updatedBooking)
    });
  } catch (error) {
    next(error);
  }
});

export default router;
