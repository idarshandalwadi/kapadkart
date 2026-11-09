import { Router } from "express";
import { prisma } from "../../config/prisma.js";
import { recordActivity } from "../../services/activity/activityService.js";
import { storageService } from "../../services/storage/index.js";
import {
  getProductStockInclude,
  formatProduct,
  formatInventoryLog
} from "./tenant.helpers.js";

const router = Router();

/**
 * GET /api/v1/tenant/products
 */
router.get('/products', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const status = req.query.status ? String(req.query.status).trim() : '';
    const gender = req.query.gender ? String(req.query.gender).trim() : '';
    const category = req.query.category ? String(req.query.category).trim() : '';
    const brand = req.query.brand ? String(req.query.brand).trim() : '';
    const availabilityType = req.query.availability_type ? String(req.query.availability_type).trim().toLowerCase() : '';
    const stock = req.query.stock ? String(req.query.stock).trim().toLowerCase() : '';
    const lowStockThreshold = Math.max(1, parseInt(req.query.low_stock_threshold, 10) || 3);

    const isAll = req.query.all === 'true' || req.query.limit === 'all';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = isAll ? 1000 : Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = isAll ? 0 : (page - 1) * limit;

    const where = { tenantId };
    if (status && status !== 'all') {
      where.status = { equals: status, mode: 'insensitive' };
    }
    if (gender && gender !== 'all') {
      where.gender = { equals: gender, mode: 'insensitive' };
    }
    if (category && category !== 'all') {
      where.category = { equals: category, mode: 'insensitive' };
    }
    if (brand && brand !== 'all') {
      where.brand = { equals: brand, mode: 'insensitive' };
    }
    if (availabilityType && availabilityType !== 'all') {
      if (availabilityType === 'rent') {
        where.availabilityType = { in: ['rent', 'both'] };
      } else if (availabilityType === 'sale' || availabilityType === 'sell') {
        where.availabilityType = { in: ['sell', 'both'] };
      } else {
        where.availabilityType = { equals: availabilityType, mode: 'insensitive' };
      }
    }

    // Stock level filtering
    if (stock === 'out_of_stock') {
      where.totalQuantity = { lte: 0 };
    } else if (stock === 'low_stock') {
      where.totalQuantity = { gt: 0, lte: lowStockThreshold };
    } else if (stock === 'in_stock') {
      where.totalQuantity = { gt: lowStockThreshold };
    } else if (stock === 'available') {
      where.status = { notIn: ['Discontinued', 'discontinued'] };
      where.totalQuantity = { gt: 0 };
    } else if (stock === 'alerts') {
      where.totalQuantity = { lte: lowStockThreshold };
    }

    if (search) {
      where.OR = [
        { productName: { contains: search, mode: 'insensitive' } },
        { productCode: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { gender: { contains: search, mode: 'insensitive' } },
        { color: { contains: search, mode: 'insensitive' } },
        { status: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Sort order mapping
    const sortBy = String(req.query.sort_by || '').toLowerCase();
    const sortOrder = String(req.query.sort_order || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const sortMapping = {
      product_name: 'productName',
      daily_rent: 'dailyRent',
      sale_price: 'salePrice',
      quantity: 'totalQuantity',
      total_quantity: 'totalQuantity',
      product_code: 'productCode',
      category: 'category',
      brand: 'brand',
      created_at: 'createdAt',
      id: 'createdAt'
    };
    const sortField = sortMapping[sortBy] || 'createdAt';

    const excludeBookingId = req.query.exclude_booking_id || req.query.excludeBookingId;
    const startDate = req.query.use_date || req.query.pickup_date || req.query.useDate || req.query.pickupDate;
    const returnDate = req.query.return_date || req.query.returnDate;

    const [countTotal, countOutOfStock, countLowStock, countInStock, total, products] = await Promise.all([
      prisma.product.count({ where: { tenantId } }),
      prisma.product.count({ where: { tenantId, totalQuantity: { lte: 0 } } }),
      prisma.product.count({ where: { tenantId, totalQuantity: { gt: 0, lte: lowStockThreshold } } }),
      prisma.product.count({ where: { tenantId, totalQuantity: { gt: lowStockThreshold } } }),
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: { [sortField]: sortOrder },
        skip,
        take: limit,
        include: getProductStockInclude({ excludeBookingId, startDate, returnDate })
      })
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.status(200).json({
      status: 'success',
      data: products.map(formatProduct),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        total_pages: totalPages
      },
      stock_summary: {
        total: countTotal,
        in_stock: countInStock,
        low_stock: countLowStock,
        out_of_stock: countOutOfStock,
        damaged: 0,
        threshold: lowStockThreshold
      },
      total
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/products
 */
router.post('/products', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const businessType = String(req.tenantUser?.business_type || 'SALES_AND_RENTAL').toUpperCase();
    const {
      product_name,
      product_code,
      size = 'FREE',
      image = '',
      image2 = '',
      category = 'General',
      brand = null,
      gender = null,
      color = '',
      purchase_price,
      daily_rent,
      sale_price,
      total_quantity,
      availability_type,
      description = '',
      status
    } = req.body;

    if (!product_name || !product_code) {
      return res.status(400).json({ status: 'error', message: 'Product name and product code are required' });
    }

    // Default total quantity to 1 if omitted, empty, or invalid
    const parsedTotalQty =
      total_quantity !== undefined && total_quantity !== '' && total_quantity !== null
        ? Math.max(0, parseInt(total_quantity, 10) || 0)
        : 1;

    // Default prices to 0 if omitted, empty, or not entered
    const parsedPurchasePrice =
      purchase_price !== undefined && purchase_price !== '' && purchase_price !== null
        ? Math.max(0, Number(purchase_price) || 0)
        : 0;

    let parsedDailyRent =
      daily_rent !== undefined && daily_rent !== '' && daily_rent !== null
        ? Math.max(0, Number(daily_rent) || 0)
        : 0;

    let parsedSalePrice =
      sale_price !== undefined && sale_price !== '' && sale_price !== null
        ? Math.max(0, Number(sale_price) || 0)
        : 0;

    // Enforce availability based on tenant business type
    let resolvedAvailability = String(
      availability_type || (businessType === 'SALES' ? 'sell' : businessType === 'RENTAL' ? 'rent' : 'both')
    ).toLowerCase();
    if (businessType === 'RENTAL') {
      resolvedAvailability = 'rent';
      parsedSalePrice = 0;
    } else if (businessType === 'SALES') {
      resolvedAvailability = 'sell';
      parsedDailyRent = 0;
    } else {
      if (!['rent', 'sell', 'both'].includes(resolvedAvailability)) {
        resolvedAvailability = 'both';
      }
    }

    const cleanBrand = brand ? String(brand).trim() : null;
    const cleanGender = gender ? String(gender).trim() : null;
    const cleanStatus = status ? String(status).trim() : 'Available';

    const product = await prisma.$transaction(async (tx) => {
      // 1. Enforce Product Creation Quota Limit
      const currentTenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { maxProducts: true, businessType: true }
      });

      if (currentTenant?.maxProducts !== null && currentTenant?.maxProducts !== undefined) {
        const productCount = await tx.product.count({ where: { tenantId } });
        if (productCount >= currentTenant.maxProducts) {
          const limitErr = new Error(`Product limit reached (${currentTenant.maxProducts}). Your shop has reached its product limit. Contact your administrator to increase your limit.`);
          limitErr.statusCode = 403;
          limitErr.code = 'PRODUCT_LIMIT_REACHED';
          limitErr.details = { resource: 'products', limit: currentTenant.maxProducts, current: productCount };
          throw limitErr;
        }
      }

      const created = await tx.product.create({
        data: {
          tenantId,
          productName: product_name,
          productCode: product_code,
          size: size || 'FREE',
          image: image || '',
          image2: image2 || '',
          category: category || 'General',
          brand: cleanBrand,
          gender: cleanGender,
          color: color || '',
          purchasePrice: parsedPurchasePrice,
          dailyRent: parsedDailyRent,
          salePrice: parsedSalePrice,
          totalQuantity: parsedTotalQty,
          availabilityType: resolvedAvailability,
          description: description || '',
          status: cleanStatus || 'Available'
        }
      });

      // Audit inventory log
      await tx.productInventoryLog.create({
        data: {
          tenantId,
          productId: created.id,
          changeType: 'INITIAL_STOCK',
          quantity: parsedTotalQty,
          previousQuantity: 0,
          newQuantity: parsedTotalQty,
          reason: 'Initial inventory entry',
          createdBy: req.tenantUser?.email || req.user?.email || 'Tenant User'
        }
      });

      return created;
    });

    recordActivity({
      tenantId,
      action: 'create',
      entityType: 'product',
      entityId: product.id,
      summary: `Created product "${product.productName}" (${product.productCode})`,
      changes: {
        name: product.productName,
        code: product.productCode,
        category: product.category,
        size: product.size,
        total_quantity: product.totalQuantity,
        daily_rent: product.dailyRent,
        sale_price: product.salePrice,
        availability_type: product.availabilityType
      },
      req
    });

    res.status(201).json({ status: 'success', data: formatProduct(product) });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        success: false,
        code: error.code || 'PRODUCT_CREATE_ERROR',
        message: error.message,
        details: error.details || null,
        fieldErrors: error.fieldErrors || null
      });
    }
    next(error);
  }
});

/**
 * GET /api/v1/tenant/products/:id
 */
router.get('/products/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const excludeBookingId = req.query.exclude_booking_id || req.query.excludeBookingId;
    const startDate = req.query.use_date || req.query.pickup_date || req.query.useDate || req.query.pickupDate;
    const returnDate = req.query.return_date || req.query.returnDate;

    const product = await prisma.product.findFirst({
      where: {
        tenantId,
        OR: [
          { id: id.includes('-') ? id : undefined },
          { productCode: id }
        ].filter(Boolean)
      },
      include: getProductStockInclude({ excludeBookingId, startDate, returnDate })
    });

    if (!product) {
      return res.status(404).json({ status: 'error', message: 'Product not found' });
    }

    res.status(200).json({ status: 'success', data: formatProduct(product) });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/tenant/products/:id
 */
router.put('/products/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const businessType = String(req.tenantUser?.business_type || 'SALES_AND_RENTAL').toUpperCase();
    const { id } = req.params;
    const {
      product_name,
      product_code,
      size,
      image,
      image2,
      category,
      brand,
      gender,
      color,
      purchase_price,
      daily_rent,
      sale_price,
      total_quantity,
      availability_type,
      description,
      status
    } = req.body;

    const existing = await prisma.product.findFirst({
      where: { id, tenantId }
    });

    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Product not found' });
    }

    // Sanitize prices and defaults to 0 if empty
    let parsedDailyRent =
      daily_rent !== undefined
        ? daily_rent !== '' && daily_rent !== null
          ? Math.max(0, Number(daily_rent) || 0)
          : 0
        : undefined;

    let parsedSalePrice =
      sale_price !== undefined
        ? sale_price !== '' && sale_price !== null
          ? Math.max(0, Number(sale_price) || 0)
          : 0
        : undefined;

    const parsedPurchasePrice =
      purchase_price !== undefined
        ? purchase_price !== '' && purchase_price !== null
          ? Math.max(0, Number(purchase_price) || 0)
          : 0
        : undefined;

    let resolvedAvailability =
      availability_type !== undefined ? String(availability_type).toLowerCase() : undefined;

    if (businessType === 'RENTAL') {
      resolvedAvailability = 'rent';
      if (parsedSalePrice !== undefined) parsedSalePrice = 0;
    } else if (businessType === 'SALES') {
      resolvedAvailability = 'sell';
      if (parsedDailyRent !== undefined) parsedDailyRent = 0;
    } else if (resolvedAvailability !== undefined) {
      if (!['rent', 'sell', 'both'].includes(resolvedAvailability)) {
        return res.status(400).json({
          status: 'error',
          message: 'Purpose (availability type) is required. Must be "rent", "sell", or "both".'
        });
      }
    }

    const updated = await prisma.product.update({
      where: { id },
      data: {
        productName: product_name !== undefined ? product_name : undefined,
        productCode: product_code !== undefined ? product_code : undefined,
        size: size !== undefined ? size : undefined,
        image: image !== undefined ? image : undefined,
        image2: image2 !== undefined ? image2 : undefined,
        category: category !== undefined ? category : undefined,
        brand: brand !== undefined ? (brand ? String(brand).trim() : null) : undefined,
        gender: gender !== undefined ? (gender ? String(gender).trim() : null) : undefined,
        color: color !== undefined ? color : undefined,
        purchasePrice: parsedPurchasePrice,
        dailyRent: parsedDailyRent,
        salePrice: parsedSalePrice,
        totalQuantity:
          total_quantity !== undefined
            ? total_quantity !== '' && total_quantity !== null
              ? Math.max(0, parseInt(total_quantity, 10) || 0)
              : 1
            : undefined,
        availabilityType: resolvedAvailability,
        description: description !== undefined ? description : undefined,
        status: status !== undefined ? (status ? String(status).trim() : 'Available') : undefined,
        updatedAt: new Date()
      }
    });

    // Delete product images that were cleared or replaced, including one entry in a JSON list.
    if (image !== undefined || image2 !== undefined) {
      await storageService.deleteRemoved(
        [existing.image, existing.image2],
        [
          image !== undefined ? image : existing.image,
          image2 !== undefined ? image2 : existing.image2
        ]
      );
    }

    recordActivity({
      tenantId,
      action: 'update',
      entityType: 'product',
      entityId: updated.id,
      summary: `Updated product "${updated.productName}" (${updated.productCode})`,
      changes: {
        name: updated.productName,
        code: updated.productCode,
        category: updated.category,
        size: updated.size,
        total_quantity: updated.totalQuantity,
        daily_rent: updated.dailyRent,
        sale_price: updated.salePrice,
        availability_type: updated.availabilityType
      },
      req
    });

    const refreshed = await prisma.product.findUnique({
      where: { id },
      include: getProductStockInclude()
    });

    res.status(200).json({ status: 'success', data: formatProduct(refreshed || updated) });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/tenant/products/:id
 */
router.delete('/products/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const existing = await prisma.product.findFirst({
      where: { id, tenantId }
    });

    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Product not found'
      });
    }

    const activeBookingItem = await prisma.bookingItem.findFirst({
      where: {
        productId: id,
        tenantId,
        isActive: true
      }
    });

    if (activeBookingItem) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot discontinue product with active bookings. Please return or cancel active bookings first.'
      });
    }

    // Products are never hard-deleted to preserve all past bills, bookings, and inventory history.
    const discontinued = await prisma.product.update({
      where: { id },
      data: {
        status: 'Discontinued',
        updatedAt: new Date()
      }
    });

    recordActivity({
      tenantId,
      action: 'update',
      entityType: 'product',
      entityId: id,
      summary: `Discontinued product "${existing.productName}" (${existing.productCode})`,
      changes: {
        name: existing.productName,
        code: existing.productCode,
        category: existing.category,
        status: 'Discontinued'
      },
      req
    });

    res.status(200).json({
      status: 'success',
      message: 'Product discontinued successfully',
      data: formatProduct(discontinued)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/products/:id/add-stock
 */
router.post('/products/:id/add-stock', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const { quantity, reason } = req.body;

    const qtyToAdd = parseInt(quantity, 10);
    if (!qtyToAdd || qtyToAdd <= 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Quantity to add must be a positive integer'
      });
    }

    const existing = await prisma.product.findFirst({
      where: { id, tenantId }
    });

    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Product not found'
      });
    }

    const previousQty = existing.totalQuantity;
    const newQty = previousQty + qtyToAdd;

    const [updatedProduct, log] = await prisma.$transaction([
      prisma.product.update({
        where: { id },
        data: {
          totalQuantity: newQty,
          updatedAt: new Date()
        }
      }),
      prisma.productInventoryLog.create({
        data: {
          tenantId,
          productId: id,
          changeType: 'STOCK_ADDED',
          quantity: qtyToAdd,
          previousQuantity: previousQty,
          newQuantity: newQty,
          reason: reason ? String(reason).trim() : 'Manual stock addition',
          createdBy: req.tenantUser?.email || req.user?.email || 'Tenant User'
        }
      })
    ]);

    recordActivity({
      tenantId,
      action: 'stock_added',
      entityType: 'product',
      entityId: id,
      summary: `Added ${qtyToAdd} unit(s) of stock to "${existing.productName}" (${existing.productCode})`,
      changes: {
        added_quantity: qtyToAdd,
        previous_quantity: previousQty,
        new_quantity: newQty,
        reason: reason || 'Manual stock addition'
      },
      req
    });

    const refreshed = await prisma.product.findUnique({
      where: { id },
      include: getProductStockInclude()
    });

    res.status(200).json({
      status: 'success',
      message: `Successfully added ${qtyToAdd} unit(s) of stock`,
      data: formatProduct(refreshed || updatedProduct),
      log: formatInventoryLog(log)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/tenant/products/:id/restore-damaged
 */
router.post('/products/:id/restore-damaged', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const { quantity, reason } = req.body;

    const qtyToRestore = parseInt(quantity, 10);
    if (!qtyToRestore || qtyToRestore <= 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Quantity to restore must be a positive integer'
      });
    }

    const existing = await prisma.product.findFirst({
      where: { id, tenantId }
    });

    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Product not found'
      });
    }

    const log = await prisma.productInventoryLog.create({
      data: {
        tenantId,
        productId: id,
        changeType: 'RESTORED',
        quantity: qtyToRestore,
        previousQuantity: existing.totalQuantity,
        newQuantity: existing.totalQuantity,
        reason: reason ? String(reason).trim() : 'Repaired damaged stock',
        createdBy: req.tenantUser?.email || req.user?.email || 'Tenant User'
      }
    });

    recordActivity({
      tenantId,
      action: 'restore_damaged',
      entityType: 'product',
      entityId: id,
      summary: `Restored ${qtyToRestore} damaged unit(s) of "${existing.productName}" (${existing.productCode}) to circulation`,
      changes: {
        restored_quantity: qtyToRestore,
        reason: reason || 'Repaired damaged stock'
      },
      req
    });

    res.status(200).json({
      status: 'success',
      message: `Successfully restored ${qtyToRestore} unit(s) to active stock`,
      data: formatProduct(existing),
      log: formatInventoryLog(log)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/tenant/products/:id/inventory-logs
 */
router.get('/products/:id/inventory-logs', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const existing = await prisma.product.findFirst({
      where: { id, tenantId }
    });

    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Product not found'
      });
    }

    const [logs, total] = await Promise.all([
      prisma.productInventoryLog.findMany({
        where: { tenantId, productId: id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.productInventoryLog.count({
        where: { tenantId, productId: id }
      })
    ]);

    res.status(200).json({
      status: 'success',
      data: logs.map(formatInventoryLog),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
