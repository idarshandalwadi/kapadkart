/**
 * KapadKart — Shared Tenant Formatters and Route Helpers
 */

export function getProductStockInclude(options = {}) {
  const { excludeBookingId, startDate, returnDate } = options;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const rangeStart = startDate && !Number.isNaN(new Date(startDate).getTime())
    ? new Date(startDate)
    : startOfDay;
  const rangeEnd = returnDate && !Number.isNaN(new Date(returnDate).getTime())
    ? new Date(returnDate)
    : endOfDay;

  const bookingWhere = {
    isActive: true,
    booking: { status: { not: 'cancelled' } },
    blockStart: { lte: rangeEnd },
    blockEnd: { gte: rangeStart }
  };

  if (excludeBookingId) {
    bookingWhere.bookingId = { not: excludeBookingId };
  }

  return {
    saleItems: {
      where: {
        sale: { status: { not: 'cancelled' } }
      },
      select: { quantity: true, sale: { select: { status: true } } }
    },
    bookingItems: {
      where: bookingWhere,
      select: { quantity: true, booking: { select: { status: true } } }
    }
  };
}

export function formatProduct(p) {
  if (!p) return null;

  const soldQty = Array.isArray(p.saleItems)
    ? p.saleItems.reduce((sum, item) => {
        if (item.sale && String(item.sale.status || '').toLowerCase() === 'cancelled') {
          return sum;
        }
        return sum + (Number(item.quantity) || 0);
      }, 0)
    : (Number(p.soldQuantity ?? p.sold_quantity) || 0);

  const rentedQty = Array.isArray(p.bookingItems)
    ? p.bookingItems.reduce((sum, item) => {
        if (item.booking && String(item.booking.status || '').toLowerCase() === 'cancelled') {
          return sum;
        }
        return sum + (Number(item.quantity) || 0);
      }, 0)
    : (Number(p.rentedQuantity ?? p.rented_quantity ?? p.rented_today) || 0);

  const inStockQty = Math.max(0, Number(p.totalQuantity) || 0);
  const damagedQty = Number(p.damagedQuantity ?? p.damaged_quantity) || 0;
  const availableQty = Math.max(0, inStockQty - rentedQty - damagedQty);
  const totalPurchasedQty = inStockQty + soldQty;

  return {
    id: p.id,
    product_name: p.productName,
    product_code: p.productCode,
    size: p.size,
    image: p.image,
    image2: p.image2,
    category: p.category,
    brand: p.brand,
    gender: p.gender,
    color: p.color,
    purchase_price: p.purchasePrice,
    daily_rent: p.dailyRent,
    sale_price: p.salePrice,
    total_quantity: inStockQty,
    available_quantity: availableQty,
    sold_quantity: soldQty,
    rented_today: rentedQty,
    rented_quantity: rentedQty,
    total_purchased_quantity: totalPurchasedQty,
    damaged_quantity: damagedQty,
    availability_type: p.availabilityType,
    description: p.description,
    status: p.status,
    created_at: p.createdAt,
    updated_at: p.updatedAt
  };
}

export function formatBookingItem(bi) {
  if (!bi) return null;
  const acc = (bi.accessories && typeof bi.accessories === 'object') ? bi.accessories : {};
  const returnedQuantity = Array.isArray(bi.returns)
    ? bi.returns.reduce((sum, r) => sum + (Number(r.returnedQuantity) || 0), 0)
    : (Number(bi.returnedQuantity ?? bi.returned_quantity) || 0);
  return {
    id: bi.id,
    product_id: bi.productId,
    quantity: bi.quantity,
    returned_quantity: returnedQuantity,
    unit_rent: bi.unitRent,
    rental_days: bi.rentalDays,
    total_amount: bi.totalAmount,
    status: bi.status,
    accessories: acc,
    choyani: acc.choyani || null,
    pant: acc.pant || null,
    sol: acc.sol || null,
    mojdi: acc.mojdi || null,
    other_items: acc.other_items || acc.otherItems || null,
    product: bi.product ? formatProduct(bi.product) : null,
    product_name: bi.product?.productName || null,
    product_code: bi.product?.productCode || null,
    product_image: bi.product?.image || null
  };
}

export function formatInventoryLog(l) {
  if (!l) return null;
  return {
    id: l.id,
    product_id: l.productId,
    change_type: l.changeType,
    quantity: l.quantity,
    previous_quantity: l.previousQuantity,
    new_quantity: l.newQuantity,
    reason: l.reason,
    reference_type: l.referenceType,
    reference_id: l.referenceId,
    created_by: l.createdBy,
    created_at: l.createdAt
  };
}

export function formatBooking(b) {
  if (!b) return null;
  return {
    id: b.id,
    bill_no: b.billNo,
    customer_name: b.customerName,
    phone_number: b.phoneNumber,
    village_address: b.villageAddress,
    pickup_date: b.pickupDate,
    return_date: b.returnDate,
    rental_days: b.rentalDays,
    security_deposit: b.securityDeposit,
    deposit_paid: Boolean(b.depositPaid ?? b.deposit_paid),
    deposit_collected: (b.depositPaid || b.deposit_paid) ? b.securityDeposit : 0,
    discount_amount: b.discountAmount,
    tax_rate: b.taxRate,
    tax_amount: b.taxAmount,
    accessories_price: b.accessoriesPrice,
    rental_total: b.rentalTotal,
    paid_amount: b.paidAmount,
    due_amount: b.dueAmount,
    notes: b.notes,
    status: b.status,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
    items: (b.bookingItems || []).map(formatBookingItem)
  };
}

export function formatSaleItem(si) {
  if (!si) return null;
  return {
    id: si.id,
    sale_id: si.saleId,
    product_id: si.productId,
    quantity: si.quantity,
    unit_price: si.unitPrice,
    discount_amount: si.discountAmount,
    tax_amount: si.taxAmount,
    total_amount: si.totalAmount,
    product: si.product ? formatProduct(si.product) : null,
    product_name: si.product?.productName || null,
    product_code: si.product?.productCode || null,
    product_image: si.product?.image || null,
    created_at: si.createdAt
  };
}

export function formatSale(s) {
  if (!s) return null;
  const items = (s.saleItems || []).map(formatSaleItem);
  const subtotal = items.reduce((sum, it) => sum + (Number(it.total_amount) || 0), 0);
  const netTotal = Number(s.saleTotal ?? s.sale_total ?? 0);
  const paid = Number(s.paidAmount ?? s.paid_amount ?? 0);
  const due = Math.max(0, netTotal - paid);

  return {
    id: s.id,
    bill_no: s.billNo,
    customer_name: s.customerName,
    phone_number: s.phoneNumber,
    village_address: s.villageAddress,
    discount_amount: s.discountAmount,
    tax_rate: s.taxRate,
    tax_amount: s.taxAmount,
    subtotal,
    sale_total: s.saleTotal,
    paid_amount: s.paidAmount,
    due_amount: due,
    notes: s.notes,
    status: s.status,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    items
  };
}

export function formatSetting(s) {
  if (!s) return null;
  return {
    id: s.id,
    company_name: s.companyName,
    page_title: s.pageTitle,
    logo_url: s.logoUrl,
    favicon_url: s.faviconUrl,
    bill_show_logo: s.billShowLogo,
    bill_show_gst: s.billShowGst,
    bill_show_upi: s.billShowUpi,
    bill_show_signature: s.billShowSignature,
    bill_show_subtotal: s.billShowSubtotal,
    bill_show_accessories: s.billShowAccessories,
    bill_show_discount: s.billShowDiscount,
    bill_show_tax: s.billShowTax,
    bill_show_security_deposit: s.billShowSecurityDeposit,
    bill_rental_title: s.billRentalTitle,
    bill_sale_title: s.billSaleTitle,
    bill_header_note: s.billHeaderNote,
    bill_footer_note: s.billFooterNote,
    phone_number: s.phoneNumber,
    address: s.address,
    gst_number: s.gstNumber,
    currency: s.currency,
    tax_rate: s.taxRate,
    upi_id: s.upiId,
    whatsapp_url: s.whatsappUrl,
    instagram_link: s.instagramLink,
    facebook_url: s.facebookUrl,
    rental_day_calculation_mode: s.rentalDayCalculationMode,
    terms_and_conditions: s.termsAndConditions,
    updated_at: s.updatedAt
  };
}

/**
 * Helper to generate sequential bill numbers per tenant
 * Formats: S-0000001 for sales, B-0000001 for bookings (7-digit zero-padded)
 */
export async function generateNextTenantBillNo(txOrPrisma, modelName, tenantId, prefix = 'S') {
  const items = await txOrPrisma[modelName].findMany({
    where: {
      tenantId,
      billNo: { startsWith: `${prefix}-` }
    },
    select: { billNo: true }
  });

  let maxSeq = 0;
  const regex = new RegExp(`^${prefix}-(\\d{7})$`, 'i');
  for (const item of items) {
    const match = item.billNo ? item.billNo.match(regex) : null;
    if (match) {
      const num = parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }

  let nextSeq = maxSeq + 1;
  let candidate = `${prefix}-${String(nextSeq).padStart(7, '0')}`;

  while (true) {
    const existing = await txOrPrisma[modelName].findFirst({
      where: { tenantId, billNo: candidate },
      select: { id: true }
    });
    if (!existing) break;
    nextSeq += 1;
    candidate = `${prefix}-${String(nextSeq).padStart(7, '0')}`;
  }

  return candidate;
}

/**
 * Unicode-aware Title Casing.
 * Capitalizes the first letter of each word and lowercases the remainder.
 * For scripts without case distinctions (such as Gujarati, Hindi, etc.),
 * characters remain completely intact.
 */
export function toTitleCase(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => {
      return word.replace(/^(\W*)(\p{L})(.*)$/u, (_, prefix, firstLetter, rest) => {
        return prefix + firstLetter.toLocaleUpperCase() + rest.toLocaleLowerCase();
      });
    })
    .join(' ');
}

/**
 * Checks whether a row is a placeholder or template example.
 * Template rows containing words like "(Sample)", "(Example)", "(Template)",
 * or starting with "Sample " / "Demo " from template files are ignored.
 */
export function isSampleCatalogRow(name) {
  if (!name || typeof name !== 'string') return true;
  const lower = name.trim().toLowerCase();
  return (
    lower.includes('(sample)') ||
    lower.includes('(example)') ||
    lower.includes('(template)') ||
    lower.includes('sample brand') ||
    lower.includes('sample category') ||
    lower.startsWith('sample ') ||
    lower === 'sample' ||
    lower === 'template' ||
    lower === 'example'
  );
}

/**
 * Format booking for rental report listing and CSV/print
 */
export function formatRentalHistoryBooking(b) {
  const base = formatBooking(b);
  if (!base) return null;
  const items = base.items || [];
  const serializedProducts = JSON.stringify({
    version: 1,
    rental_days: b.rentalDays || 1,
    items: items.map(it => ({
      product_id: it.product_id,
      product_code: it.product_code || '',
      product_name: it.product_name || 'Product',
      quantity: Number(it.quantity) || 1,
      unit_price: Number(it.unit_rent) || 0,
      line_total: Number(it.total_amount) || 0,
      choyani: it.choyani || '',
      pant: it.pant || '',
      sol: it.sol || '',
      mojdi: it.mojdi || '',
      other_items: it.other_items || ''
    }))
  });

  return {
    ...base,
    village: b.villageAddress || '',
    order_date: b.pickupDate || b.createdAt,
    grand_total: b.rentalTotal,
    product_and_code: serializedProducts,
    selected_products: serializedProducts
  };
}

/** Rentals that can still appear on the returns schedule. */
export const OPEN_RETURN_STATUSES = [
  'booked',
  'dispatched',
  'sent',
  'partially_returned',
  'confirmed',
  'delivered'
];

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function kolkataDateParts(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function istBound(year, month, day, end) {
  const utc = Date.UTC(
    year,
    month - 1,
    day,
    end ? 23 : 0,
    end ? 59 : 0,
    end ? 59 : 0,
    end ? 999 : 0
  );
  return new Date(utc - IST_OFFSET_MS);
}

function addCalendarDays(year, month, day, days) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate()
  };
}

/**
 * Day window for the dashboard returns schedule, in Asia/Kolkata.
 * Tabs: overdue, today, tomorrow, upcoming (day after tomorrow through 7 days out).
 */
export function returnsScheduleWhere(tab, now = new Date()) {
  const today = kolkataDateParts(now);
  const tomorrow = addCalendarDays(today.year, today.month, today.day, 1);
  const dayAfterTomorrow = addCalendarDays(today.year, today.month, today.day, 2);
  const plus7 = addCalendarDays(today.year, today.month, today.day, 7);
  const key = String(tab || 'today').trim().toLowerCase();

  if (key === 'overdue') {
    return { returnDate: { lt: istBound(today.year, today.month, today.day, false) } };
  }
  if (key === 'tomorrow') {
    return {
      returnDate: {
        gte: istBound(tomorrow.year, tomorrow.month, tomorrow.day, false),
        lte: istBound(tomorrow.year, tomorrow.month, tomorrow.day, true)
      }
    };
  }
  if (key === 'upcoming') {
    return {
      returnDate: {
        gte: istBound(dayAfterTomorrow.year, dayAfterTomorrow.month, dayAfterTomorrow.day, false),
        lte: istBound(plus7.year, plus7.month, plus7.day, true)
      }
    };
  }
  return {
    returnDate: {
      gte: istBound(today.year, today.month, today.day, false),
      lte: istBound(today.year, today.month, today.day, true)
    }
  };
}

const CLOSED_BOOKING_STATUSES = ['cancelled', 'returned', 'completed'];

/**
 * Inclusive Asia/Kolkata day for a YYYY-MM-DD value.
 * Date-only filters from the browser are shop-local days, not UTC midnights.
 */
export function istDateRange(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return {
    gte: istBound(year, month, day, false),
    lte: istBound(year, month, day, true)
  };
}

export function istTodayRange(now = new Date()) {
  const today = kolkataDateParts(now);
  return {
    ...today,
    gte: istBound(today.year, today.month, today.day, false),
    lte: istBound(today.year, today.month, today.day, true)
  };
}

/** createdAt window for date-only from/to query params. */
export function istCreatedAtRange(from, to) {
  const range = {};
  const start = istDateRange(from);
  const end = istDateRange(to);
  if (start) range.gte = start.gte;
  if (end) range.lte = end.lte;
  return Object.keys(range).length ? range : null;
}

/**
 * Dashboard tiles and the booking list share these views.
 * Returns null when `view` is a normal booking status.
 */
export function bookingListViewWhere(view, now = new Date()) {
  const key = String(view || '').trim().toLowerCase();
  const today = istTodayRange(now);
  const tomorrow = addCalendarDays(today.year, today.month, today.day, 1);
  const plus15 = addCalendarDays(today.year, today.month, today.day, 15);

  if (key === 'pickup_today') {
    return {
      status: { notIn: CLOSED_BOOKING_STATUSES },
      pickupDate: { gte: today.gte, lte: today.lte }
    };
  }
  if (key === 'due_today') {
    return {
      status: { in: OPEN_RETURN_STATUSES, mode: 'insensitive' },
      returnDate: { gte: today.gte, lte: today.lte }
    };
  }
  if (key === 'upcoming_delivery') {
    return {
      status: { notIn: CLOSED_BOOKING_STATUSES },
      pickupDate: {
        gte: istBound(tomorrow.year, tomorrow.month, tomorrow.day, false),
        lte: istBound(plus15.year, plus15.month, plus15.day, true)
      }
    };
  }
  if (key === 'overdue') {
    return {
      status: { in: OPEN_RETURN_STATUSES, mode: 'insensitive' },
      returnDate: { lt: today.gte }
    };
  }
  if (key === 'created_today') {
    return {
      status: { notIn: ['cancelled'] },
      createdAt: { gte: today.gte, lte: today.lte }
    };
  }
  if (key === 'outstanding') {
    return {
      status: { notIn: ['cancelled'] },
      dueAmount: { gt: 0 }
    };
  }
  return null;
}

export function returnLateness(returnDate, now = new Date()) {
  const today = kolkataDateParts(now);
  const due = kolkataDateParts(new Date(returnDate));
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const dueUtc = Date.UTC(due.year, due.month - 1, due.day);
  const overdueDays = Math.round((todayUtc - dueUtc) / 86400000);
  return {
    is_overdue: overdueDays > 0,
    overdue_days: Math.max(0, overdueDays)
  };
}

export async function queryReturnsSchedule(db, tenantId, query = {}, now = new Date()) {
  const tab = String(query.tab || 'today').trim().toLowerCase();
  const parsedLimit = parseInt(query.limit, 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30));
  const bookings = await db.booking.findMany({
    where: {
      tenantId,
      status: { in: OPEN_RETURN_STATUSES, mode: 'insensitive' },
      ...returnsScheduleWhere(tab, now)
    },
    include: {
      bookingItems: {
        include: {
          product: true,
          returns: true
        }
      }
    },
    orderBy: { returnDate: 'asc' },
    take: limit
  });

  const data = bookings.map((booking) => ({
    ...formatBooking(booking),
    ...returnLateness(booking.returnDate, now)
  }));

  return { tab, limit, data, total: data.length };
}

