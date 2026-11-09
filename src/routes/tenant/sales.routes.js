import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { recordActivity } from "../../services/activity/activityService.js";
import {
  formatSale,
  generateNextTenantBillNo,
  istCreatedAtRange
} from "./tenant.helpers.js";

const router = Router();

/**
 * GET /api/v1/tenant/sales/next-bill-no
 */
router.get('/sales/next-bill-no', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const billNo = await generateNextTenantBillNo(prisma, 'sale', tenantId, 'S');
    res.status(200).json({ status: 'success', data: { bill_no: billNo }, bill_no: billNo });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/sales
 */
router.get('/sales', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const status = req.query.status ? String(req.query.status).trim() : '';
    const from = req.query.from ? String(req.query.from).trim() : '';
    const to = req.query.to ? String(req.query.to).trim() : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

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
        { saleItems: { some: { product: { productName: { contains: search, mode: 'insensitive' } } } } },
        { saleItems: { some: { product: { productCode: { contains: search, mode: 'insensitive' } } } } }
      ];
    }
    if (from || to) {
      const createdAt = istCreatedAtRange(from, to);
      if (createdAt) where.createdAt = createdAt;
    }

    const sortBy = req.query.sort_by || 'createdAt';
    const sortOrder = req.query.sort_order === 'asc' ? 'asc' : 'desc';
    const orderMapping = {
      bill_no: 'billNo',
      created_at: 'createdAt',
      total: 'saleTotal',
      sale_total: 'saleTotal',
      paid: 'paidAmount',
      paid_amount: 'paidAmount',
      discount: 'discountAmount',
      discount_amount: 'discountAmount',
      customer: 'customerName'
    };
    const orderByField = orderMapping[sortBy] || 'createdAt';

    const [total, sales] = await Promise.all([
      prisma.sale.count({ where }),
      prisma.sale.findMany({
        where,
        include: {
          saleItems: {
            include: {
              product: true
            }
          }
        },
        orderBy: { [orderByField]: sortOrder },
        skip,
        take: limit
      })
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.status(200).json({
      status: 'success',
      data: sales.map(formatSale),
      pagination: {
        page,
        limit,
        total,
        totalPages
      },
      total
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/sales
 */
router.post('/sales', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;

    const currentTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { maxSales: true, businessType: true }
    });

    if (currentTenant?.businessType === 'RENTAL') {
      return res.status(400).json({
        status: 'error',
        message: 'Direct sales are disabled for this shop. Business type is Rental only.'
      });
    }

    const {
      bill_no,
      customer_name,
      phone_number,
      village_address = '',
      items = [],
      discount_amount = 0,
      tax_rate = 0,
      tax_amount = 0,
      paid_amount = 0,
      notes = ''
    } = req.body;

    if (!customer_name || !phone_number || items.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Missing customer info or items for POS sale' });
    }

    const invalidSaleItem = items.some((item) => {
      const price = Number(item.unit_price);
      const qty = Number(item.quantity);
      return !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 1;
    });
    if (invalidSaleItem) {
      return res.status(400).json({
        status: 'error',
        success: false,
        code: 'INVALID_ITEM_PRICE',
        message: 'Each sale item must have a quantity of at least 1 and a unit price greater than 0.',
        fieldErrors: {
          items: 'Each sale item must have a quantity of at least 1 and a unit price greater than 0.'
        }
      });
    }

    const grossItemsTotal = items.reduce(
      (sum, i) => sum + (Number(i.unit_price || 0) * (Number(i.quantity) || 1)),
      0
    );

    if (!Number.isFinite(grossItemsTotal) || grossItemsTotal <= 0) {
      return res.status(400).json({
        status: 'error',
        success: false,
        code: 'INVALID_TOTAL',
        message: 'Sale total amount must be greater than 0.'
      });
    }

    const discountVal = Math.max(0, Number(discount_amount) || 0);
    const taxRateVal = Math.max(0, Number(tax_rate) || 0);
    const taxVal = Math.max(0, Number(tax_amount) || 0);
    const netSaleTotal = Math.max(0, grossItemsTotal - discountVal + taxVal);

    const sale = await prisma.$transaction(async (tx) => {
      // 0. Ensure unique sequential bill number per tenant (starts at S-0000001)
      let finalBillNo = bill_no ? String(bill_no).trim() : '';
      if (!finalBillNo) {
        finalBillNo = await generateNextTenantBillNo(tx, 'sale', tenantId, 'S');
      } else {
        const existingBill = await tx.sale.findFirst({
          where: { tenantId, billNo: finalBillNo },
          select: { id: true }
        });
        if (existingBill) {
          finalBillNo = await generateNextTenantBillNo(tx, 'sale', tenantId, 'S');
        }
      }
      // 1. Enforce Sales Quota Limit
      if (currentTenant?.maxSales !== null && currentTenant?.maxSales !== undefined) {
        const salesCount = await tx.sale.count({ where: { tenantId } });
        if (salesCount >= currentTenant.maxSales) {
          const limitErr = new Error(`Sales limit reached (${currentTenant.maxSales}). Your shop has reached its sales limit. Contact your administrator to increase your limit.`);
          limitErr.statusCode = 403;
          limitErr.code = 'SALES_LIMIT_REACHED';
          limitErr.details = { resource: 'sales', limit: currentTenant.maxSales, current: salesCount };
          throw limitErr;
        }
      }

      const createdSale = await tx.sale.create({
        data: {
          tenantId,
          billNo: finalBillNo,
          customerName: customer_name,
          phoneNumber: phone_number,
          villageAddress: village_address,
          discountAmount: discountVal,
          taxRate: taxRateVal,
          taxAmount: taxVal,
          saleTotal: netSaleTotal,
          paidAmount: paid_amount !== undefined && paid_amount !== null ? Number(paid_amount) : netSaleTotal,
          notes,
          status: 'completed'
        }
      });

      for (const item of items) {
        const itemQty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
        const itemUnitPrice = Number(item.unit_price) || 0;
        const itemGross = itemQty * itemUnitPrice;

        const itemDiscount = item.discount_amount !== undefined && item.discount_amount !== null
          ? Number(item.discount_amount)
          : grossItemsTotal > 0
            ? Math.round((discountVal * itemGross / grossItemsTotal) * 100) / 100
            : 0;

        const itemTaxable = Math.max(0, itemGross - itemDiscount);
        const itemTax = item.tax_amount !== undefined && item.tax_amount !== null
          ? Number(item.tax_amount)
          : taxRateVal > 0
            ? Math.round((itemTaxable * taxRateVal / 100) * 100) / 100
            : 0;

        const itemTotal = item.total_amount !== undefined && item.total_amount !== null
          ? Number(item.total_amount)
          : Math.round((itemTaxable + itemTax) * 100) / 100;

        await tx.saleItem.create({
          data: {
            tenantId,
            saleId: createdSale.id,
            productId: item.product_id,
            quantity: itemQty,
            unitPrice: itemUnitPrice,
            discountAmount: itemDiscount,
            taxAmount: itemTax,
            totalAmount: itemTotal
          }
        });

        // Decrement inventory stock on retail sale
        await tx.product.updateMany({
          where: { id: item.product_id, tenantId },
          data: {
            totalQuantity: { decrement: item.quantity },
            updatedAt: new Date()
          }
        });

        // Record log
        await tx.productInventoryLog.create({
          data: {
            tenantId,
            productId: item.product_id,
            changeType: 'SALE',
            quantity: item.quantity,
            previousQuantity: 0,
            newQuantity: 0,
            reason: 'Retail POS sale checkout',
            createdBy: req.tenantUser?.email || req.user?.email || 'Tenant User'
          }
        });
      }

      return createdSale;
    });

    recordActivity({
      tenantId,
      action: 'create',
      entityType: 'sale',
      entityId: sale.id,
      summary: `Created direct sale #${sale.billNo} for customer ${sale.customerName} (₹${sale.saleTotal})`,
      changes: {
        bill_no: sale.billNo,
        customer_name: sale.customerName,
        phone_number: sale.phoneNumber,
        sale_total: sale.saleTotal,
        paid_amount: sale.paidAmount,
        items_count: items.length
      },
      req
    });

    res.status(201).json({ status: 'success', data: formatSale(sale) });
  } catch (error) {
    res.status(error.statusCode || 400).json({
      status: 'error',
      success: false,
      code: error.code || 'SALE_CREATE_ERROR',
      message: error.message,
      details: error.details || null,
      fieldErrors: error.fieldErrors || null
    });
  }
});

/**
 * PUT /api/v1/tenant/sales/:id
 * Update an existing sale or cancel and restore stock
 */
router.put('/sales/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Sale not found' });
    }

    const existingSale = await prisma.sale.findFirst({
      where: { id, tenantId },
      include: { saleItems: true }
    });

    if (!existingSale) {
      return res.status(404).json({ status: 'error', message: 'Sale not found' });
    }

    const saleAgeDays = (Date.now() - new Date(existingSale.createdAt).getTime()) / (1000 * 60 * 60 * 24);

    const {
      status,
      customer_name,
      phone_number,
      village_address,
      items,
      discount_amount,
      tax_rate,
      tax_amount,
      paid_amount,
      notes
    } = req.body;

    const isCancelling = status && status.toLowerCase() === 'cancelled' && existingSale.status.toLowerCase() !== 'cancelled';
    if (isCancelling && saleAgeDays > 45) {
      return res.status(400).json({
        status: 'error',
        message: 'Cancellation is no longer allowed after 45 days from sale date'
      });
    }

    if (!isCancelling && saleAgeDays > 30) {
      return res.status(400).json({
        status: 'error',
        message: 'Editing is no longer allowed after 30 days from sale date'
      });
    }

    const updatedSale = await prisma.$transaction(async (tx) => {
      // 1. If cancelling a previously non-cancelled sale, restore stock
      if (status && status.toLowerCase() === 'cancelled' && existingSale.status.toLowerCase() !== 'cancelled') {
        for (const item of existingSale.saleItems) {
          await tx.product.updateMany({
            where: { id: item.productId, tenantId },
            data: {
              totalQuantity: { increment: item.quantity },
              updatedAt: new Date()
            }
          });

          await tx.productInventoryLog.create({
            data: {
              tenantId,
              productId: item.productId,
              changeType: 'RESTOCK',
              quantity: item.quantity,
              previousQuantity: 0,
              newQuantity: 0,
              reason: `Sale #${existingSale.billNo} cancelled - stock restored`,
              createdBy: req.tenantUser?.email || req.user?.email || 'Tenant User'
            }
          });
        }

        return tx.sale.update({
          where: { id },
          data: { status: 'cancelled' },
          include: { saleItems: { include: { product: true } } }
        });
      }

      // 2. Normal update
      const updateData = {};
      if (customer_name !== undefined) updateData.customerName = customer_name.trim();
      if (phone_number !== undefined) updateData.phoneNumber = phone_number.trim();
      if (village_address !== undefined) updateData.villageAddress = village_address ? village_address.trim() : null;
      if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
      if (status !== undefined) updateData.status = status;

      const effectiveTaxRate = tax_rate !== undefined && tax_rate !== null
        ? Math.max(0, Number(tax_rate) || 0)
        : Number(existingSale.taxRate || 0);

      if (tax_rate !== undefined) {
        updateData.taxRate = effectiveTaxRate;
      }

      if (items && Array.isArray(items) && items.length > 0) {
        // Return previous stock first
        for (const prevItem of existingSale.saleItems) {
          await tx.product.updateMany({
            where: { id: prevItem.productId, tenantId },
            data: {
              totalQuantity: { increment: prevItem.quantity },
              updatedAt: new Date()
            }
          });
        }

        // Delete old sale items
        await tx.saleItem.deleteMany({ where: { saleId: id, tenantId } });

        // Calculate new gross items total
        const grossItemsTotal = items.reduce(
          (sum, i) => sum + (Number(i.unit_price || 0) * (Number(i.quantity) || 1)),
          0
        );
        const discountVal = discount_amount !== undefined ? Math.max(0, Number(discount_amount) || 0) : Number(existingSale.discountAmount || 0);
        const taxVal = tax_amount !== undefined ? Math.max(0, Number(tax_amount) || 0) : Number(existingSale.taxAmount || 0);
        const netSaleTotal = Math.max(0, grossItemsTotal - discountVal + taxVal);
        const paidVal = paid_amount !== undefined && paid_amount !== null ? Number(paid_amount) : Number(existingSale.paidAmount || netSaleTotal);

        updateData.discountAmount = discountVal;
        updateData.taxAmount = taxVal;
        updateData.saleTotal = netSaleTotal;
        updateData.paidAmount = paidVal;

        // Insert new sale items & decrement stock
        for (const item of items) {
          const itemQty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
          const itemUnitPrice = Number(item.unit_price) || 0;
          const itemGross = itemQty * itemUnitPrice;

          const itemDiscount = item.discount_amount !== undefined && item.discount_amount !== null
            ? Number(item.discount_amount)
            : grossItemsTotal > 0
              ? Math.round((discountVal * itemGross / grossItemsTotal) * 100) / 100
              : 0;

          const itemTaxable = Math.max(0, itemGross - itemDiscount);
          const itemTax = item.tax_amount !== undefined && item.tax_amount !== null
            ? Number(item.tax_amount)
            : effectiveTaxRate > 0
              ? Math.round((itemTaxable * effectiveTaxRate / 100) * 100) / 100
              : 0;

          const itemTotal = item.total_amount !== undefined && item.total_amount !== null
            ? Number(item.total_amount)
            : Math.round((itemTaxable + itemTax) * 100) / 100;

          await tx.saleItem.create({
            data: {
              tenantId,
              saleId: id,
              productId: item.product_id,
              quantity: itemQty,
              unitPrice: itemUnitPrice,
              discountAmount: itemDiscount,
              taxAmount: itemTax,
              totalAmount: itemTotal
            }
          });

          await tx.product.updateMany({
            where: { id: item.product_id, tenantId },
            data: {
              totalQuantity: { decrement: itemQty },
              updatedAt: new Date()
            }
          });
        }
      } else {
        // Items not changed, but discount, tax, or paid amount might have changed
        const currentGross = existingSale.saleItems.reduce((sum, i) => sum + (Number(i.unitPrice || 0) * Number(i.quantity || 1)), 0);
        const discountVal = discount_amount !== undefined ? Math.max(0, Number(discount_amount) || 0) : Number(existingSale.discountAmount || 0);
        const taxVal = tax_amount !== undefined ? Math.max(0, Number(tax_amount) || 0) : Number(existingSale.taxAmount || 0);
        const netSaleTotal = Math.max(0, currentGross - discountVal + taxVal);

        if (discount_amount !== undefined) updateData.discountAmount = discountVal;
        if (tax_amount !== undefined) updateData.taxAmount = taxVal;
        if (discount_amount !== undefined || tax_amount !== undefined) updateData.saleTotal = netSaleTotal;
        if (paid_amount !== undefined && paid_amount !== null) updateData.paidAmount = Number(paid_amount);
      }

      return tx.sale.update({
        where: { id },
        data: updateData,
        include: { saleItems: { include: { product: true } } }
      });
    });

    recordActivity({
      tenantId,
      action: 'update',
      entityType: 'sale',
      entityId: id,
      summary: `Updated sale #${existingSale.billNo} (${updatedSale.status})`,
      req
    });

    res.status(200).json({ status: 'success', data: formatSale(updatedSale) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/sales/report-summary
 * Summary KPIs and Revenue Chart for Retail Sales
 */
router.get('/sales/report-summary', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const chartDays = Math.min(365, Math.max(1, parseInt(req.query.chart_days, 10) || 7));

    const [completedSalesAgg, completedCount, cancelledCount, itemsSoldAgg] = await Promise.all([
      prisma.sale.aggregate({
        where: { tenantId, status: { in: ['completed', 'COMPLETED'] } },
        _sum: { saleTotal: true }
      }),
      prisma.sale.count({
        where: { tenantId, status: { in: ['completed', 'COMPLETED'] } }
      }),
      prisma.sale.count({
        where: { tenantId, status: { in: ['cancelled', 'CANCELLED'] } }
      }),
      prisma.saleItem.aggregate({
        where: {
          tenantId,
          sale: { status: { in: ['completed', 'COMPLETED'] } }
        },
        _sum: { quantity: true }
      })
    ]);

    const totalRevenueCompleted = Number(completedSalesAgg._sum?.saleTotal || 0);
    const totalProductsSold = Number(itemsSoldAgg._sum?.quantity || 0);

    const now = new Date();
    const days = [];
    const dayBuckets = [];

    for (let i = chartDays - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
      const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      days.push({ startOfDay, endOfDay, label });
    }

    const chartStartDate = days[0].startOfDay;
    const chartEndDate = days[days.length - 1].endOfDay;

    const periodSales = await prisma.sale.findMany({
      where: {
        tenantId,
        status: { in: ['completed', 'COMPLETED'] },
        createdAt: { gte: chartStartDate, lte: chartEndDate }
      },
      select: {
        createdAt: true,
        saleTotal: true,
        paidAmount: true,
        discountAmount: true,
        taxAmount: true,
        saleItems: { select: { totalAmount: true } }
      }
    });

    for (const day of days) {
      let paidAmount = 0;
      let totalAmount = 0;
      let salesCount = 0;

      for (const s of periodSales) {
        const sTime = new Date(s.createdAt).getTime();
        if (sTime >= day.startOfDay.getTime() && sTime <= day.endOfDay.getTime()) {
          const gross = (s.saleItems || []).reduce((acc, it) => acc + Number(it.totalAmount || 0), 0);
          const disc = Number(s.discountAmount || 0);
          const tax = Number(s.taxAmount || 0);
          const tot = gross > 0 && Number(s.saleTotal) === gross && disc > 0
            ? Math.max(0, gross - disc + tax)
            : Number(s.saleTotal || 0);
          const pd = Number(s.paidAmount || 0);
          totalAmount += tot;
          paidAmount += pd;
          salesCount += 1;
        }
      }

      dayBuckets.push({
        label: day.label,
        paidAmount: totalAmount,
        dueAmount: 0,
        totalAmount,
        amount: totalAmount,
        sales: salesCount
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        quickStats: {
          totalRevenueCompleted,
          totalProductsSold,
          completedSales: completedCount,
          cancelledSales: cancelledCount
        },
        revenueChart: {
          title: 'Sales Revenue',
          subtitle: `Revenue trend over the last ${chartDays} days`,
          days: dayBuckets
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/sales/:id
 */
router.get('/sales/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    if (id === 'report-summary' || id === 'next-bill-no') {
      return next();
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Sale not found' });
    }

    const sale = await prisma.sale.findFirst({
      where: { id, tenantId },
      include: {
        saleItems: {
          include: {
            product: true
          }
        }
      }
    });

    if (!sale) {
      return res.status(404).json({ status: 'error', message: 'Sale not found' });
    }

    res.status(200).json({ status: 'success', data: formatSale(sale) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/sales/:id/share-link
 * Generates an expiring public download link for a sale bill with images
 */
router.post('/sales/:id/share-link', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) {
      return res.status(404).json({ status: 'error', message: 'Sale not found' });
    }

    const sale = await prisma.sale.findFirst({
      where: { id, tenantId }
    });

    if (!sale) {
      return res.status(404).json({ status: 'error', message: 'Sale not found' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const ttlHours = parseInt(process.env.BILL_SHARE_TOKEN_TTL_HOURS || '72', 10);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const shareToken = await prisma.billShareToken.create({
      data: {
        token,
        type: 'sale',
        recordId: sale.id,
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

export default router;
