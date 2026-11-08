import { Router } from 'express';
import { prisma } from '../config/prisma.js';
import { streamBillPdf } from '../services/pdf/billPdfService.js';

const router = Router();

function formatSaleItem(si) {
  if (!si) return null;
  return {
    id: si.id,
    quantity: si.quantity,
    unit_price: si.unitPrice,
    discount_amount: si.discountAmount,
    tax_amount: si.taxAmount,
    total_amount: si.totalAmount,
    product_name: si.product?.productName || null,
    product_code: si.product?.productCode || null,
    product_image: si.product?.image || null
  };
}

function formatSale(s) {
  if (!s) return null;
  return {
    id: s.id,
    bill_no: s.billNo,
    customer_name: s.customerName,
    phone_number: s.phoneNumber,
    village_address: s.villageAddress,
    discount_amount: s.discountAmount,
    tax_amount: s.taxAmount,
    sale_total: s.saleTotal,
    paid_amount: s.paidAmount,
    notes: s.notes,
    status: s.status,
    created_at: s.createdAt,
    items: (s.saleItems || []).map(formatSaleItem)
  };
}

function formatBookingItem(bi) {
  if (!bi) return null;
  const acc = (bi.accessories && typeof bi.accessories === 'object') ? bi.accessories : {};
  return {
    id: bi.id,
    quantity: bi.quantity,
    unit_rent: bi.unitRent,
    rental_days: bi.rentalDays,
    total_amount: bi.totalAmount,
    accessories: acc,
    choyani: acc.choyani || null,
    pant: acc.pant || null,
    sol: acc.sol || null,
    mojdi: acc.mojdi || null,
    other_items: acc.other_items || acc.otherItems || null,
    product_name: bi.product?.productName || null,
    product_code: bi.product?.productCode || null,
    product_image: bi.product?.image || null
  };
}

function formatBooking(b) {
  if (!b) return null;
  return {
    id: b.id,
    bill_no: b.billNo,
    customer_name: b.customerName,
    phone_number: b.phoneNumber,
    village_address: b.villageAddress,
    pickup_date: b.pickupDate,
    return_date: b.returnDate,
    security_deposit: b.securityDeposit,
    deposit_paid: Boolean(b.depositPaid ?? b.deposit_paid),
    deposit_collected: (b.depositPaid || b.deposit_paid) ? b.securityDeposit : 0,
    accessories_price: b.accessoriesPrice,
    discount_amount: b.discountAmount,
    tax_rate: b.taxRate,
    tax_amount: b.taxAmount,
    rental_total: b.rentalTotal,
    paid_amount: b.paidAmount,
    due_amount: b.dueAmount,
    notes: b.notes,
    status: b.status,
    created_at: b.createdAt,
    items: (b.bookingItems || []).map(formatBookingItem)
  };
}

async function loadBillByToken(token) {
  if (!token) return null;

  const shareToken = await prisma.billShareToken.findUnique({
    where: { token }
  });

  if (!shareToken) {
    return { error: 'NOT_FOUND', message: 'Bill download link not found or invalid' };
  }

  if (new Date(shareToken.expiresAt) < new Date()) {
    return { error: 'EXPIRED', message: 'This bill download link has expired' };
  }

  const [settings, tenant] = await Promise.all([
    prisma.setting.findUnique({ where: { tenantId: shareToken.tenantId } }),
    prisma.tenant.findUnique({ where: { id: shareToken.tenantId }, select: { name: true, slug: true } })
  ]);

  const mergedSettings = {
    ...settings,
    company_name: settings?.companyName || tenant?.name || 'KapadKart Store'
  };

  let record = null;
  if (shareToken.type === 'sale') {
    const rawSale = await prisma.sale.findUnique({
      where: { id: shareToken.recordId },
      include: {
        saleItems: {
          include: { product: true }
        }
      }
    });
    if (!rawSale) {
      return { error: 'NOT_FOUND', message: 'Referenced sale bill record not found' };
    }
    record = formatSale(rawSale);
  } else {
    const rawBooking = await prisma.booking.findUnique({
      where: { id: shareToken.recordId },
      include: {
        bookingItems: {
          include: { product: true }
        }
      }
    });
    if (!rawBooking) {
      return { error: 'NOT_FOUND', message: 'Referenced booking bill record not found' };
    }
    record = formatBooking(rawBooking);
  }

  return {
    shareToken,
    record,
    type: shareToken.type,
    settings: mergedSettings
  };
}

/**
 * GET /api/v1/public/bills/download/:token
 * Generates and streams PDF with invoice data and product images via Node.js PDFKit
 */
router.get('/bills/download/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await loadBillByToken(token);

    if (result?.error === 'NOT_FOUND') {
      return res.status(404).json({ status: 'error', message: result.message });
    }
    if (result?.error === 'EXPIRED') {
      return res.status(410).json({ status: 'error', message: result.message });
    }

    const { record, type, settings } = result;

    const safeCustomer = (record.customer_name || 'Customer').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeBillNo = (record.bill_no || 'Invoice').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeCustomer}_${safeBillNo}.pdf`;

    // Direct download by default across all mobile and desktop OS/browsers; supports ?inline=true for preview
    const isInline = req.query.inline === 'true' || req.query.view === 'true';
    const disposition = isInline ? 'inline' : 'attachment';

    await streamBillPdf({
      record,
      type,
      settings,
      token,
      fileName,
      disposition,
      res
    });
  } catch (error) {
    console.error('[PublicBillDownload] Error streaming PDF:', error);
    if (!res.headersSent) {
      next(error);
    }
  }
});

/**
 * GET /api/v1/public/bills/:token
 * Returns bill JSON data if needed
 */
router.get('/bills/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await loadBillByToken(token);

    if (result?.error === 'NOT_FOUND') {
      return res.status(404).json({ status: 'error', message: result.message });
    }
    if (result?.error === 'EXPIRED') {
      return res.status(410).json({ status: 'error', message: result.message });
    }

    res.status(200).json({
      status: 'success',
      data: {
        record: result.record,
        type: result.type,
        settings: result.settings,
        expires_at: result.shareToken.expiresAt
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
