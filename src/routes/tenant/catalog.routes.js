import { Router } from "express";
import { prisma } from "../../config/prisma.js";
import { recordActivity } from "../../services/activity/activityService.js";
import { toTitleCase, isSampleCatalogRow } from "./tenant.helpers.js";

const router = Router();

/**
 * Categories CRUD
 */
router.get('/categories', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const pageParam = req.query.page;

    if (pageParam !== undefined) {
      const page = Math.max(1, parseInt(pageParam, 10) || 1);
      const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
      const skip = (page - 1) * limit;

      const [categories, total] = await Promise.all([
        prisma.category.findMany({
          where: { tenantId },
          select: { id: true, name: true, createdAt: true },
          orderBy: { name: 'asc' },
          skip,
          take: limit
        }),
        prisma.category.count({ where: { tenantId } })
      ]);

      return res.status(200).json({
        status: 'success',
        data: categories,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1
        }
      });
    }

    const categories = await prisma.category.findMany({
      where: { tenantId },
      select: { id: true, name: true, createdAt: true },
      orderBy: { name: 'asc' }
    });
    res.status(200).json({ status: 'success', data: categories });
  } catch (error) {
    next(error);
  }
});

router.post('/categories', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ status: 'error', message: 'Category name is required' });
    }
    const cleanName = toTitleCase(name);
    if (cleanName.length > 20) {
      return res.status(400).json({ status: 'error', message: 'Category name cannot exceed 20 characters' });
    }
    const existing = await prisma.category.findFirst({
      where: { tenantId, name: { equals: cleanName, mode: 'insensitive' } }
    });
    if (existing) {
      return res.status(409).json({
        status: 'error',
        message: `Category "${existing.name}" already exists`
      });
    }
    const category = await prisma.category.create({
      data: { tenantId, name: cleanName },
      select: { id: true, name: true, createdAt: true }
    });
    recordActivity({
      tenantId,
      action: 'create',
      entityType: 'category',
      entityId: category.id,
      summary: `Created category "${cleanName}"`,
      req
    });
    res.status(201).json({ status: 'success', data: category });
  } catch (error) {
    next(error);
  }
});

router.post('/categories/resolve', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ status: 'error', message: 'Category name is required' });
    }
    const cleanName = toTitleCase(name).slice(0, 20);
    let category = await prisma.category.findFirst({
      where: { tenantId, name: { equals: cleanName, mode: 'insensitive' } },
      select: { id: true, name: true, createdAt: true }
    });
    if (!category) {
      category = await prisma.category.create({
        data: { tenantId, name: cleanName },
        select: { id: true, name: true, createdAt: true }
      });
      recordActivity({
        tenantId,
        action: 'create',
        entityType: 'category',
        entityId: category.id,
        summary: `Created category "${cleanName}"`,
        req
      });
    }
    res.status(200).json({ status: 'success', data: category });
  } catch (error) {
    next(error);
  }
});

router.post('/categories/bulk', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const rawItems = Array.isArray(req.body.items)
      ? req.body.items
      : Array.isArray(req.body.names)
        ? req.body.names
        : [];

    if (!rawItems.length) {
      return res.status(400).json({ status: 'error', message: 'No items provided for import' });
    }

    let ignoredSampleCount = 0;
    let duplicateInBatchCount = 0;
    const candidates = [];
    const seenInBatch = new Set();

    for (const raw of rawItems) {
      const trimmed = String(raw || '').trim();
      if (!trimmed) continue;
      if (isSampleCatalogRow(trimmed)) {
        ignoredSampleCount++;
        continue;
      }
      const formatted = toTitleCase(trimmed).slice(0, 20);
      const lowerKey = formatted.toLowerCase();
      if (seenInBatch.has(lowerKey)) {
        duplicateInBatchCount++;
      } else {
        seenInBatch.add(lowerKey);
        candidates.push(formatted);
      }
    }

    if (!candidates.length) {
      if (ignoredSampleCount > 0) {
        return res.status(400).json({
          status: 'error',
          message: 'The uploaded file contains only sample template data. Please add your actual categories before importing.'
        });
      }
      return res.status(400).json({ status: 'error', message: 'No valid category names found in file' });
    }

    const existingRecords = await prisma.category.findMany({
      where: { tenantId },
      select: { name: true }
    });
    const existingLower = new Set(existingRecords.map((r) => r.name.toLowerCase()));

    const toCreate = candidates.filter((cName) => !existingLower.has(cName.toLowerCase()));
    const duplicateInDbCount = candidates.length - toCreate.length;
    const skippedCount = duplicateInBatchCount + duplicateInDbCount;

    const created = [];
    for (const cName of toCreate) {
      const rec = await prisma.category.create({
        data: { tenantId, name: cName },
        select: { id: true, name: true, createdAt: true }
      });
      created.push(rec);
    }

    const source = req.body.source || (ignoredSampleCount > 0 ? 'csv' : 'sheet');

    if (created.length > 0) {
      const label = source === 'sheet' ? 'Bulk sheet added' : 'Imported';
      recordActivity({
        tenantId,
        action: 'bulk_create',
        entityType: 'category',
        entityId: tenantId,
        summary: `${label} ${created.length} categories (${skippedCount} duplicates skipped, ${ignoredSampleCount} template rows ignored)`,
        metadata: {
          source,
          importedCount: created.length,
          skippedCount,
          ignoredSampleCount,
          createdNames: created.map((c) => c.name)
        },
        req
      });

      logger.info(`[Tenant ${tenantId}] Bulk created ${created.length} categories via ${source}`, {
        tenantId,
        source,
        importedCount: created.length,
        skippedCount,
        ignoredSampleCount,
        createdNames: created.map((c) => c.name)
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        importedCount: created.length,
        skippedCount,
        ignoredSampleCount,
        createdItems: created
      }
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const existing = await prisma.category.findFirst({
      where: { id, tenantId }
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Category not found' });
    }

    // Check if any products are using this category
    const productCount = await prisma.product.count({
      where: {
        tenantId,
        category: { equals: existing.name, mode: 'insensitive' }
      }
    });

    if (productCount > 0) {
      return res.status(400).json({
        status: 'error',
        message: `Cannot delete category "${existing.name}" because ${productCount} product(s) are assigned to it. Please reassign or delete the products first.`
      });
    }

    await prisma.category.deleteMany({
      where: { id, tenantId }
    });
    recordActivity({
      tenantId,
      action: 'delete',
      entityType: 'category',
      entityId: id,
      summary: `Deleted category "${existing.name}"`,
      req
    });
    res.status(200).json({ status: 'success', message: 'Category deleted successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * Brands CRUD
 */
router.get('/brands', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const pageParam = req.query.page;

    if (pageParam !== undefined) {
      const page = Math.max(1, parseInt(pageParam, 10) || 1);
      const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
      const skip = (page - 1) * limit;

      const [brands, total] = await Promise.all([
        prisma.brand.findMany({
          where: { tenantId },
          select: { id: true, name: true, createdAt: true },
          orderBy: { name: 'asc' },
          skip,
          take: limit
        }),
        prisma.brand.count({ where: { tenantId } })
      ]);

      return res.status(200).json({
        status: 'success',
        data: brands,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1
        }
      });
    }

    const brands = await prisma.brand.findMany({
      where: { tenantId },
      select: { id: true, name: true, createdAt: true },
      orderBy: { name: 'asc' }
    });
    res.status(200).json({ status: 'success', data: brands });
  } catch (error) {
    next(error);
  }
});

router.post('/brands', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ status: 'error', message: 'Brand name is required' });
    }
    const cleanName = toTitleCase(name);
    if (cleanName.length > 20) {
      return res.status(400).json({ status: 'error', message: 'Brand name cannot exceed 20 characters' });
    }
    const existing = await prisma.brand.findFirst({
      where: { tenantId, name: { equals: cleanName, mode: 'insensitive' } }
    });
    if (existing) {
      return res.status(409).json({
        status: 'error',
        message: `Brand "${existing.name}" already exists`
      });
    }
    const brand = await prisma.brand.create({
      data: { tenantId, name: cleanName },
      select: { id: true, name: true, createdAt: true }
    });
    recordActivity({
      tenantId,
      action: 'create',
      entityType: 'brand',
      entityId: brand.id,
      summary: `Created brand "${cleanName}"`,
      req
    });
    res.status(201).json({ status: 'success', data: brand });
  } catch (error) {
    next(error);
  }
});

router.post('/brands/resolve', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ status: 'error', message: 'Brand name is required' });
    }
    const cleanName = toTitleCase(name).slice(0, 20);
    let brand = await prisma.brand.findFirst({
      where: { tenantId, name: { equals: cleanName, mode: 'insensitive' } },
      select: { id: true, name: true, createdAt: true }
    });
    if (!brand) {
      brand = await prisma.brand.create({
        data: { tenantId, name: cleanName },
        select: { id: true, name: true, createdAt: true }
      });
      recordActivity({
        tenantId,
        action: 'create',
        entityType: 'brand',
        entityId: brand.id,
        summary: `Created brand "${cleanName}"`,
        req
      });
    }
    res.status(200).json({ status: 'success', data: brand });
  } catch (error) {
    next(error);
  }
});

router.post('/brands/bulk', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const rawItems = Array.isArray(req.body.items)
      ? req.body.items
      : Array.isArray(req.body.names)
        ? req.body.names
        : [];

    if (!rawItems.length) {
      return res.status(400).json({ status: 'error', message: 'No items provided for import' });
    }

    let ignoredSampleCount = 0;
    let duplicateInBatchCount = 0;
    const candidates = [];
    const seenInBatch = new Set();

    for (const raw of rawItems) {
      const trimmed = String(raw || '').trim();
      if (!trimmed) continue;
      if (isSampleCatalogRow(trimmed)) {
        ignoredSampleCount++;
        continue;
      }
      const formatted = toTitleCase(trimmed).slice(0, 20);
      const lowerKey = formatted.toLowerCase();
      if (seenInBatch.has(lowerKey)) {
        duplicateInBatchCount++;
      } else {
        seenInBatch.add(lowerKey);
        candidates.push(formatted);
      }
    }

    if (!candidates.length) {
      if (ignoredSampleCount > 0) {
        return res.status(400).json({
          status: 'error',
          message: 'The uploaded file contains only sample template data. Please add your actual brands before importing.'
        });
      }
      return res.status(400).json({ status: 'error', message: 'No valid brand names found in file' });
    }

    const existingRecords = await prisma.brand.findMany({
      where: { tenantId },
      select: { name: true }
    });
    const existingLower = new Set(existingRecords.map((r) => r.name.toLowerCase()));

    const toCreate = candidates.filter((bName) => !existingLower.has(bName.toLowerCase()));
    const duplicateInDbCount = candidates.length - toCreate.length;
    const skippedCount = duplicateInBatchCount + duplicateInDbCount;

    const created = [];
    for (const bName of toCreate) {
      const rec = await prisma.brand.create({
        data: { tenantId, name: bName },
        select: { id: true, name: true, createdAt: true }
      });
      created.push(rec);
    }

    const source = req.body.source || (ignoredSampleCount > 0 ? 'csv' : 'sheet');

    if (created.length > 0) {
      const label = source === 'sheet' ? 'Bulk sheet added' : 'Imported';
      recordActivity({
        tenantId,
        action: 'bulk_create',
        entityType: 'brand',
        entityId: tenantId,
        summary: `${label} ${created.length} brands (${skippedCount} duplicates skipped, ${ignoredSampleCount} template rows ignored)`,
        metadata: {
          source,
          importedCount: created.length,
          skippedCount,
          ignoredSampleCount,
          createdNames: created.map((c) => c.name)
        },
        req
      });

      logger.info(`[Tenant ${tenantId}] Bulk created ${created.length} brands via ${source}`, {
        tenantId,
        source,
        importedCount: created.length,
        skippedCount,
        ignoredSampleCount,
        createdNames: created.map((c) => c.name)
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        importedCount: created.length,
        skippedCount,
        ignoredSampleCount,
        createdItems: created
      }
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/brands/:id', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const existing = await prisma.brand.findFirst({
      where: { id, tenantId }
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Brand not found' });
    }

    // Check if any products are using this brand
    const productCount = await prisma.product.count({
      where: {
        tenantId,
        brand: { equals: existing.name, mode: 'insensitive' }
      }
    });

    if (productCount > 0) {
      return res.status(400).json({
        status: 'error',
        message: `Cannot delete brand "${existing.name}" because ${productCount} product(s) are assigned to it. Please reassign or delete the products first.`
      });
    }

    await prisma.brand.deleteMany({
      where: { id, tenantId }
    });
    recordActivity({
      tenantId,
      action: 'delete',
      entityType: 'brand',
      entityId: id,
      summary: `Deleted brand "${existing.name}"`,
      req
    });
    res.status(200).json({ status: 'success', message: 'Brand deleted successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
