import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONT_PATH = path.resolve(__dirname, '../../assets/fonts/AnekGujarati.ttf');

/**
 * Extract clean VPA from raw string or upi:// URI
 */
function extractUpiVpa(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^upi:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const pa = url.searchParams.get('pa');
      return pa ? pa.trim() : '';
    } catch {
      const match = value.match(/[?&]pa=([^&]+)/i);
      return match ? decodeURIComponent(match[1]).trim() : '';
    }
  }
  return value;
}

/**
 * Build UPI deep-link / payment URI
 */
function buildUpiUri({ upiId, payeeName = '', amount = null, billNo = null, currency = 'INR' }) {
  const vpa = extractUpiVpa(upiId);
  if (!vpa) return null;
  const parts = [`pa=${encodeURIComponent(vpa)}`];
  if (payeeName) parts.push(`pn=${encodeURIComponent(payeeName.trim())}`);
  const due = Number(amount);
  if (Number.isFinite(due) && due > 0) parts.push(`am=${encodeURIComponent(due.toFixed(2))}`);
  parts.push(`cu=${encodeURIComponent(currency || 'INR')}`);
  if (billNo) parts.push(`tn=${encodeURIComponent(String(billNo).trim())}`);
  return `upi://pay?${parts.join('&')}`;
}

/**
 * Generate PNG QR code buffer using qrcode library
 */
async function generateQrBuffer(text, width = 120) {
  if (!text || typeof text !== 'string') return null;
  try {
    return await QRCode.toBuffer(text.trim(), {
      width,
      margin: 1,
      color: {
        dark: '#111111',
        light: '#FFFFFF'
      }
    });
  } catch (err) {
    console.warn('[PDFKit] Failed to generate QR buffer:', err.message);
    return null;
  }
}

/**
 * Format numeric value as Indian Rupee (INR)
 */
function formatCurrency(val, useSymbol = true) {
  const num = Number(val || 0);
  if (Number.isNaN(num)) return useSymbol ? '₹0.00' : 'Rs. 0.00';
  const formatted = num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return useSymbol ? `₹${formatted}` : `Rs. ${formatted}`;
}

/**
 * Format a Date object or string to DD/MM/YYYY (matching direct browser print)
 */
function formatDate(dateVal) {
  if (!dateVal) return '—';
  try {
    const d = new Date(dateVal);
    if (Number.isNaN(d.getTime())) return String(dateVal);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return String(dateVal);
  }
}

/**
 * Parse product image field which may be a single URL, a JSON array string, or comma-separated list
 */
function parseProductImages(imageField) {
  if (!imageField) return [];
  if (Array.isArray(imageField)) {
    return imageField.map((s) => String(s || '').trim()).filter(Boolean);
  }
  if (typeof imageField !== 'string') return [];
  const trimmed = imageField.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s || '').trim()).filter(Boolean);
      }
    } catch (_) {}
  }

  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts;
  }

  return [trimmed];
}

/**
 * Safe resolve of image buffer from local file system or remote URL
 */
async function resolveImageBuffer(imgUrlOrPath) {
  if (!imgUrlOrPath || typeof imgUrlOrPath !== 'string') return null;

  let cleanPath = imgUrlOrPath.trim();
  if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
    try {
      const parsed = new URL(cleanPath);
      if (parsed.pathname.startsWith('/uploads/')) {
        cleanPath = parsed.pathname;
      }
    } catch (_) {}
  }

  let rawBuffer = null;

  // 1. Local disk uploads
  if (cleanPath.startsWith('/uploads/') || cleanPath.startsWith('uploads/')) {
    const rel = cleanPath.replace(/^\/?uploads\/?/, '');
    const uploadsDir = path.resolve(process.cwd(), process.env.LOCAL_UPLOAD_DIR || 'uploads');
    const localFile = path.resolve(uploadsDir, rel);
    if (fs.existsSync(localFile)) {
      try {
        rawBuffer = fs.readFileSync(localFile);
      } catch (err) {
        console.warn(`[PDFKit] Failed to read local file ${localFile}:`, err.message);
      }
    }
  }

  // 2. Remote HTTP/HTTPS fetch
  if (!rawBuffer && (cleanPath.startsWith('http://') || cleanPath.startsWith('https://'))) {
    try {
      const res = await fetch(cleanPath, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const arrBuffer = await res.arrayBuffer();
        rawBuffer = Buffer.from(arrBuffer);
      }
    } catch (err) {
      console.warn(`[PDFKit] Failed to fetch remote image ${cleanPath}:`, err.message);
    }
  }

  if (!rawBuffer) return null;

  // 3. Check if image is WebP (PDFKit only decodes JPEG & PNG natively)
  // Convert WebP buffer to PNG so PDFKit renders crisp logos and product pictures
  if (
    rawBuffer.length > 12 &&
    rawBuffer[0] === 0x52 &&
    rawBuffer[1] === 0x49 &&
    rawBuffer[2] === 0x46 &&
    rawBuffer[3] === 0x46 &&
    rawBuffer[8] === 0x57 &&
    rawBuffer[9] === 0x45 &&
    rawBuffer[10] === 0x42 &&
    rawBuffer[11] === 0x50
  ) {
    try {
      const sharp = (await import('sharp')).default;
      return await sharp(rawBuffer).png().toBuffer();
    } catch (webpErr) {
      console.warn('[PDFKit] WebP to PNG conversion failed:', webpErr.message);
      return rawBuffer;
    }
  }

  return rawBuffer;
}

/**
 * Generate a complete Bill PDF using PDFKit strictly and return Buffer.
 *
 * @param {Object} options
 * @param {Object} options.record - Sale or Booking object with items
 * @param {'sale'|'booking'} options.type - 'sale' or 'booking'
 * @param {Object} options.settings - Tenant settings / branding
 * @param {string|null} [options.token] - Public share token for digital link
 * @returns {Promise<Buffer>}
 */
export async function generateBillPdfBuffer({ record, type = 'sale', settings = {}, token = null }) {
  return new Promise(async (resolve, reject) => {
    try {
      const isBooking = type === 'booking';
      const margin = 24; // 8.5mm margins to mirror direct print
      const doc = new PDFDocument({
        size: 'A4',
        margin,
        bufferPages: true
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const baseUrl = (process.env.FRONTEND_ORIGIN || process.env.BASE_URL || 'https://kapadkart.in').replace(/\/+$/, '');
  const digitalInvoiceUrl =
    record?.shared_url ||
    record?.download_url ||
    record?.share_url ||
    (token ? `${baseUrl}/public/bills/download/${token}` : null);

  const hasFont = fs.existsSync(FONT_PATH);
  if (hasFont) {
    try {
      doc.registerFont('AppFont', FONT_PATH);
      doc.registerFont('AppFont-Bold', FONT_PATH);
    } catch (fontErr) {
      console.warn('[PDFKit] Font registration warning:', fontErr.message);
    }
  }
  const fontRegular = hasFont ? 'AppFont' : 'Helvetica';
  const fontBold = hasFont ? 'AppFont-Bold' : 'Helvetica-Bold';
  const cur = (val) => formatCurrency(val, hasFont);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentWidth = pageWidth - margin * 2;

  // --------------------------------------------------------------------------
  // PAGE 1: INVOICE DETAILS (Styled identically to direct browser print)
  // --------------------------------------------------------------------------

  // Pre-load logo buffer if any
  const logoUrl = settings?.logo_url || settings?.logoUrl;
  const showLogo = settings?.bill_show_logo !== false && settings?.billShowLogo !== false;
  let logoBuffer = null;
  if (showLogo && logoUrl) {
    logoBuffer = await resolveImageBuffer(logoUrl);
  }

  let y = margin;

  // 1. Header: Store info (left) & Invoice Meta (right)
  const headerLeftX = margin;
  const headerRightWidth = 190;
  const headerRightX = margin + contentWidth - headerRightWidth;

  let currentLeftY = y;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, headerLeftX, currentLeftY, { fit: [160, 48] });
      currentLeftY += 51;
    } catch (e) {
      console.warn('[PDFKit] Logo rendering warning:', e.message);
    }
  }

  const companyName = settings?.company_name || settings?.companyName || 'KapadKart';
  doc.font(fontBold).fontSize(12).fillColor('#111111').text(companyName, headerLeftX, currentLeftY);
  currentLeftY += 15;

  doc.font(fontRegular).fontSize(7.6).fillColor('#444444');
  if (settings?.address) {
    doc.text(settings.address, headerLeftX, currentLeftY, { width: contentWidth * 0.52, lineGap: 1 });
    currentLeftY = doc.y + 1.5;
  }
  const gstRaw = String(settings?.gst_number || settings?.gstNumber || '').trim();
  const hasGstNumber = gstRaw && gstRaw !== '0' && gstRaw.toLowerCase() !== 'null' && gstRaw.toLowerCase() !== 'none';
  const contactParts = [
    settings?.phone_number || settings?.phoneNumber,
    hasGstNumber ? `GST: ${gstRaw}` : null
  ].filter(Boolean);
  if (contactParts.length > 0) {
    doc.text(contactParts.join(' · '), headerLeftX, currentLeftY);
    currentLeftY = doc.y + 1.5;
  }
  const headerNote = settings?.bill_header_note || settings?.billHeaderNote;
  if (headerNote) {
    doc.font(fontRegular).fontSize(7).fillColor('#444444');
    doc.text(headerNote, headerLeftX, currentLeftY, { width: contentWidth * 0.52, lineGap: 1.5 });
    currentLeftY = doc.y + 1.5;
  }

  // Header Right (Bill details)
  let currentRightY = y;
  const billTitle = isBooking
    ? (settings?.bill_rental_title || settings?.billRentalTitle || 'RENTAL INVOICE')
    : (settings?.bill_sale_title || settings?.billSaleTitle || 'SALE BILL');

  doc.font(fontBold).fontSize(11).fillColor('#111111')
    .text(billTitle.toUpperCase(), headerRightX, currentRightY, { width: headerRightWidth, align: 'right' });
  currentRightY += 16;

  const billNo = record?.bill_no || record?.billNo || '—';
  doc.font(fontRegular).fontSize(7.5).fillColor('#111111')
    .text(`Bill No: ${billNo}`, headerRightX, currentRightY, { width: headerRightWidth, align: 'right' });
  currentRightY += 11;

  const billDate = formatDate(record?.created_at || record?.createdAt);
  doc.font(fontRegular).fontSize(7.5).fillColor('#111111')
    .text(`Date: ${billDate}`, headerRightX, currentRightY, { width: headerRightWidth, align: 'right' });
  currentRightY += 11;

  if (isBooking) {
    const pickupDate = formatDate(record?.pickup_date || record?.pickupDate);
    const returnDate = formatDate(record?.return_date || record?.returnDate);
    doc.text(`Pickup: ${pickupDate}`, headerRightX, currentRightY, { width: headerRightWidth, align: 'right' });
    currentRightY += 10;
    doc.text(`Return: ${returnDate}`, headerRightX, currentRightY, { width: headerRightWidth, align: 'right' });
    currentRightY += 10;
  }

  // Status pill badge
  const rawStatus = String(record?.status || 'completed').toLowerCase();
  const statusDisplay = String(record?.status || 'COMPLETED').toUpperCase();
  let pillBg = '#DCFCE7';
  let pillText = '#15803D';
  if (rawStatus === 'cancelled') {
    pillBg = '#FEE2E2';
    pillText = '#B91C1C';
  } else if (rawStatus === 'reserved' || rawStatus === 'pending') {
    pillBg = '#FEF3C7';
    pillText = '#B45309';
  } else if (rawStatus === 'sent' || rawStatus === 'picked_up') {
    pillBg = '#DBEAFE';
    pillText = '#1D4ED8';
  } else if (rawStatus === 'returned' || rawStatus === 'partially_returned') {
    pillBg = '#F3E8FF';
    pillText = '#7C3AED';
  }

  const pillW = doc.widthOfString(statusDisplay, { fontSize: 6.5, font: fontBold }) + 10;
  const pillH = 12;
  const pillX = margin + contentWidth - pillW;
  const pillY = currentRightY;

  doc.font(fontBold).fontSize(7.5).fillColor('#111111')
    .text('Status:', headerRightX, currentRightY + 1.5, { width: headerRightWidth - pillW - 6, align: 'right' });
  doc.roundedRect(pillX, pillY, pillW, pillH, 6).fill(pillBg);
  doc.font(fontBold).fontSize(6.5).fillColor(pillText)
    .text(statusDisplay, pillX, pillY + 2.5, { width: pillW, align: 'center' });
  currentRightY += 16;

  y = Math.max(currentLeftY, currentRightY) + 4;

  // Solid black 1.5pt divider line under header (matching direct print)
  doc.strokeColor('#111111').lineWidth(1.5).moveTo(margin, y).lineTo(margin + contentWidth, y).stroke();
  y += 7;

  // 2. Customer Section (Matches direct print 2-column grid)
  doc.font(fontBold).fontSize(6.4).fillColor('#444444').text('CUSTOMER', margin, y);
  y += 8;

  const custName = record?.customer_name || record?.customerName || 'Walk-in Customer';
  const custPhone = record?.phone_number || record?.phoneNumber || '—';
  const custAddress = record?.village_address || record?.villageAddress || '';

  const colWidth = (contentWidth - 16) / 2;
  const col1X = margin;
  const col2X = margin + colWidth + 16;

  doc.font(fontBold).fontSize(5.8).fillColor('#666666').text('NAME', col1X, y);
  doc.font(fontBold).fontSize(5.8).fillColor('#666666').text('PHONE', col2X, y);
  y += 7;

  doc.font(fontRegular).fontSize(7.8).fillColor('#111111').text(custName, col1X, y, { width: colWidth });
  doc.font(fontRegular).fontSize(7.8).fillColor('#111111').text(custPhone, col2X, y, { width: colWidth });
  y = Math.max(doc.y, y + 11);

  if (custAddress) {
    y += 2;
    doc.font(fontBold).fontSize(5.8).fillColor('#666666').text('ADDRESS', col1X, y);
    y += 7;
    doc.font(fontRegular).fontSize(7.8).fillColor('#111111').text(custAddress, col1X, y, { width: contentWidth, lineGap: 1.5 });
    y = doc.y + 4;
  }
  y += 4;

  // 3. Items Table
  doc.font(fontBold).fontSize(6.4).fillColor('#444444').text('ITEMS', margin, y);
  y += 8;

  const items = record?.items || [];
  const colX = isBooking
    ? { item: margin + 4, itemWidth: contentWidth - 235, qty: margin + contentWidth - 230, qtyWidth: 40, rate: margin + contentWidth - 185, rateWidth: 65, days: margin + contentWidth - 115, daysWidth: 40, total: margin + contentWidth - 70, totalWidth: 70 }
    : { item: margin + 4, itemWidth: contentWidth - 215, qty: margin + contentWidth - 210, qtyWidth: 45, rate: margin + contentWidth - 160, rateWidth: 75, total: margin + contentWidth - 80, totalWidth: 80 };

  function drawTableHeader(currentY) {
    doc.rect(margin, currentY, contentWidth, 15).fill('#F2F2F2');
    doc.strokeColor('#DDDDDD').lineWidth(1).moveTo(margin, currentY + 15).lineTo(margin + contentWidth, currentY + 15).stroke();
    doc.font(fontBold).fontSize(5.8).fillColor('#111111');

    doc.text('ITEM', colX.item, currentY + 4);
    doc.text('QTY', colX.qty, currentY + 4, { width: colX.qtyWidth, align: 'right' });

    if (isBooking) {
      doc.text('RENT/DAY', colX.rate, currentY + 4, { width: colX.rateWidth, align: 'right' });
      doc.text('DAYS', colX.days, currentY + 4, { width: colX.daysWidth, align: 'right' });
    } else {
      doc.text('UNIT PRICE', colX.rate, currentY + 4, { width: colX.rateWidth, align: 'right' });
    }
    doc.text('AMOUNT', colX.total, currentY + 4, { width: colX.totalWidth - 4, align: 'right' });
    return currentY + 15;
  }

  y = drawTableHeader(y);

  // Table items with single-line code parentheses: ProductName (ProductCode)
  doc.font(fontRegular).fontSize(7.4).fillColor('#111111');
  items.forEach((item) => {
    const name = item.product_name || item.productName || item.product?.productName || 'Item';
    const code = item.product_code || item.productCode || item.product?.productCode || '';
    const itemText = code ? `${name} (${code})` : name;
    const qty = item.quantity || 1;
    const rate = isBooking ? (item.unit_rent ?? item.unitRent ?? 0) : (item.unit_price ?? item.unitPrice ?? 0);
    const lineTotal = item.total_amount ?? item.totalAmount ?? (qty * rate);

    const rowY = y;
    doc.font(fontRegular).fontSize(7.4).fillColor('#111111')
      .text(itemText, colX.item, rowY + 3, { width: colX.itemWidth, lineGap: 1.5 });
    let itemEndY = doc.y;

    const acc = (item.accessories && typeof item.accessories === 'object') ? item.accessories : item;
    const accEntries = [];
    if (acc.choyani) accEntries.push({ label: 'Choyni', val: String(acc.choyani) });
    if (acc.pant) accEntries.push({ label: 'Pant', val: String(acc.pant) });
    if (acc.sol) accEntries.push({ label: 'Sholl', val: String(acc.sol) });
    if (acc.mojdi && acc.mojdi !== 'N/A') accEntries.push({ label: 'Mojdi', val: String(acc.mojdi) });
    if (acc.other_items || acc.otherItems) accEntries.push({ label: 'Other', val: String(acc.other_items || acc.otherItems) });

    if (accEntries.length > 0) {
      let curX = colX.item;
      let curY = doc.y + 2;
      const chipHeight = 9.5;
      const chipPadH = 3;

      // Draw prefix 'INCLUDED:'
      doc.font(fontBold).fontSize(5.5).fillColor('#4B5563');
      const prefixText = 'INCLUDED:';
      const prefixWidth = doc.widthOfString(prefixText);
      doc.text(prefixText, curX, curY + 2);
      curX += prefixWidth + 4;

      doc.fontSize(5.8);

      for (const entry of accEntries) {
        doc.font(fontBold);
        const labelText = `${entry.label}: `;
        const labelW = doc.widthOfString(labelText);

        doc.font(fontRegular);
        const valText = entry.val;
        const valW = doc.widthOfString(valText);

        const chipW = labelW + valW + (chipPadH * 2);

        // Wrap to next line if chip exceeds column width
        if (curX + chipW > colX.item + colX.itemWidth) {
          curX = colX.item;
          curY += chipHeight + 2;
        }

        // Draw chip badge background & border
        doc.fillColor('#F3F4F6')
          .strokeColor('#D1D5DB')
          .lineWidth(0.5)
          .roundedRect(curX, curY, chipW, chipHeight, 2)
          .fillAndStroke();

        // Draw accessory label
        doc.font(fontBold).fontSize(5.6).fillColor('#374151')
          .text(labelText, curX + chipPadH, curY + 1.8, { lineBreak: false });

        // Draw accessory value
        doc.font(fontBold).fontSize(5.6).fillColor('#111827')
          .text(valText, curX + chipPadH + labelW, curY + 1.8, { lineBreak: false });

        curX += chipW + 3;
      }
      itemEndY = Math.max(doc.y, curY + chipHeight);
    }

    doc.font(fontRegular).fontSize(7.4).fillColor('#111111')
      .text(String(qty), colX.qty, rowY + 3, { width: colX.qtyWidth, align: 'right' });

    if (isBooking) {
      doc.text(cur(rate), colX.rate, rowY + 3, { width: colX.rateWidth, align: 'right' });
      doc.text(String(item.rental_days || item.rentalDays || 1), colX.days, rowY + 3, { width: colX.daysWidth, align: 'right' });
    } else {
      doc.text(cur(rate), colX.rate, rowY + 3, { width: colX.rateWidth, align: 'right' });
    }

    doc.text(cur(lineTotal), colX.total, rowY + 3, { width: colX.totalWidth - 4, align: 'right' });

    y = Math.max(itemEndY + 3, rowY + 16);
    doc.strokeColor('#DDDDDD').lineWidth(0.5).moveTo(margin, y).lineTo(margin + contentWidth, y).stroke();
  });

  // 4. Financial Totals & Payment Summary (Color-coded to match direct print)
  const discount = Math.max(0, Number(record?.discount_amount || record?.discountAmount || 0));
  const taxRate = Number(record?.tax_rate ?? record?.taxRate ?? 0);
  const tax = Math.max(0, Number(record?.tax_amount || record?.taxAmount || 0));
  const secDeposit = isBooking ? Math.max(0, Number(record?.security_deposit || record?.securityDeposit || 0)) : 0;
  const accessoriesPrice = isBooking ? Math.max(0, Number(record?.accessories_price || record?.accessoriesPrice || 0)) : 0;

  const duration = isBooking ? Math.max(1, Number(record?.rental_days || record?.rentalDays || 1)) : 1;
  const itemsSum = (items || []).reduce((sum, it) => {
    const q = it.quantity || 1;
    const rate = isBooking ? (it.unit_rent ?? it.unitRent ?? 0) : (it.unit_price ?? it.unitPrice ?? 0);
    const lineTotal = it.total_amount ?? it.totalAmount ?? (q * rate * duration);
    return sum + Number(lineTotal);
  }, 0);

  const rawSubtotal = record?.subtotal !== '' && record?.subtotal != null ? Number(record?.subtotal) : null;
  const productsSubtotal = itemsSum > 0 ? itemsSum : (rawSubtotal != null && !Number.isNaN(rawSubtotal) ? rawSubtotal : 0);

  const totalSubtotal = productsSubtotal + accessoriesPrice;

  const depositPaid = isBooking
    ? Boolean(record?.deposit_paid || record?.depositPaid)
    : false;

  const baseRentalTotal = isBooking
    ? Number(record?.rental_total ?? record?.rentalTotal ?? Math.max(0, totalSubtotal - discount + tax))
    : Number(record?.sale_total ?? record?.saleTotal ?? Math.max(0, productsSubtotal - discount + tax));

  const rawPaid = record?.paid_amount !== '' && record?.paid_amount != null
    ? Number(record?.paid_amount || record?.paidAmount)
    : null;
  const paid = rawPaid != null && !Number.isNaN(rawPaid) ? Math.max(0, rawPaid) : 0;

  const rawDue = record?.due_amount !== '' && record?.due_amount != null
    ? Number(record?.due_amount || record?.dueAmount)
    : null;
  const due = rawDue != null && !Number.isNaN(rawDue)
    ? Math.max(0, rawDue)
    : Math.max(0, baseRentalTotal - paid);

  y += 7;
  // Full-width divider line above Payment Summary
  doc.strokeColor('#CCCCCC').lineWidth(1).moveTo(margin, y).lineTo(margin + contentWidth, y).stroke();
  y += 6;

  const panelWidth = 175;
  const panelX = margin + contentWidth - panelWidth;
  doc.font(fontBold).fontSize(6.4).fillColor('#444444').text('PAYMENT SUMMARY', panelX, y);
  y += 9;

  let rowY = y;
  function drawSummaryRow({ label, value, color = '#111111', isBold = false, isFinal = false, isDue = false, hasBorder = true }) {
    const fontSize = (isFinal || isDue) ? 8.8 : 7.8;
    const labelFont = (isBold || isFinal || isDue) ? fontBold : fontRegular;
    const valFont = (isBold || isFinal || isDue) ? fontBold : fontRegular;

    doc.font(labelFont).fontSize(fontSize).fillColor(color).text(label, panelX, rowY + 2);
    doc.font(valFont).fontSize(fontSize).fillColor(color).text(value, panelX, rowY + 2, { width: panelWidth, align: 'right' });
    rowY += 13;
    if (hasBorder) {
      doc.strokeColor('#DDDDDD').lineWidth(0.5).moveTo(panelX, rowY).lineTo(panelX + panelWidth, rowY).stroke();
    }
  }

  // 1. Subtotal
  drawSummaryRow({ label: isBooking ? 'Rental Subtotal' : 'Subtotal', value: cur(productsSubtotal) });

  // 1.1 Accessories
  if (isBooking && accessoriesPrice > 0) {
    drawSummaryRow({ label: 'Accessories', value: cur(accessoriesPrice) });
  }

  // 2. Instant Discount (Red)
  if (discount > 0) {
    drawSummaryRow({ label: 'Instant Discount', value: `-${cur(discount)}`, color: '#B91C1C' });
  }

  // 3. Tax (Only shown if tax amount and tax rate > 0)
  if (tax > 0 && taxRate > 0) {
    const taxLabel = `Tax (${taxRate}%)`;
    drawSummaryRow({ label: taxLabel, value: cur(tax) });
  }

  // 4. Breakdown based on Rental vs Sales & Deposit Paid vs Pending
  if (isBooking && secDeposit > 0) {
    if (depositPaid) {
      // Case A: Deposit is Paid
      drawSummaryRow({ label: 'Final Rental Amount', value: cur(baseRentalTotal), isBold: true });
      if (paid > 0) {
        drawSummaryRow({ label: 'Advance Rent Paid (Jama)', value: `-${cur(paid)}`, color: '#15803D', isBold: true });
      }
      if (due > 0) {
        drawSummaryRow({ label: 'Remaining Rent Due (Baki)', value: cur(due), color: '#B45309', isBold: true, isDue: true });
      } else {
        drawSummaryRow({ label: 'Remaining Rent Due (Baki)', value: cur(0), color: '#15803D', isBold: true, isDue: true });
      }
      drawSummaryRow({ label: 'Security Deposit Held', value: cur(secDeposit), color: '#15803D', isBold: true, hasBorder: false });
    } else {
      // Case B: Deposit is NOT Paid (Pending to be collected at pickup)
      drawSummaryRow({ label: 'Final Rental Amount', value: cur(baseRentalTotal), isBold: true });
      if (paid > 0) {
        drawSummaryRow({ label: 'Advance Rent Paid (Jama)', value: `-${cur(paid)}`, color: '#15803D', isBold: true });
      }
      if (due > 0) {
        drawSummaryRow({ label: 'Remaining Rent Due (Baki)', value: cur(due), color: '#B45309', isBold: true, isDue: true });
      }
      drawSummaryRow({ label: 'Security Deposit (Pending)', value: cur(secDeposit), color: '#B45309', isBold: true });
      const totalPendingAtPickup = due + secDeposit;
      if (totalPendingAtPickup > 0) {
        drawSummaryRow({ label: 'Total Due at Pickup', value: cur(totalPendingAtPickup), color: '#B45309', isBold: true, isDue: true, hasBorder: false });
      }
    }
  } else {
    // Standard Sales or Booking with 0 deposit
    const isFullyPaidSame = Math.abs(baseRentalTotal - paid) < 0.01 && paid > 0;
    if (isFullyPaidSame) {
      drawSummaryRow({ label: 'Final / Paid Amount', value: cur(baseRentalTotal), isBold: true, isFinal: true, hasBorder: false });
    } else {
      drawSummaryRow({ label: isBooking ? 'Final Rental Amount' : 'Final Amount', value: cur(baseRentalTotal), isBold: true, isFinal: true, hasBorder: false });
      if (paid > 0) {
        drawSummaryRow({ label: isBooking ? 'Advance Rent Paid (Jama)' : 'Paid Amount', value: cur(paid), color: '#15803D', isBold: true, hasBorder: false });
      }
    }
    if (due > 0) {
      drawSummaryRow({ label: isBooking ? 'Remaining Rent Due (Baki)' : 'Remaining Due (Baki)', value: cur(due), color: '#B45309', isBold: true, isDue: true, hasBorder: false });
    }
  }

  y = rowY + 8;

  // 5. UPI QR Code & Social Media QR Codes in Dashed White Box
  const upiId = settings?.upi_id || settings?.upiId;
  const vpa = extractUpiVpa(upiId);
  const upiUri = vpa
    ? buildUpiUri({ upiId: vpa, payeeName: companyName, amount: due > 0 ? due : baseRentalTotal, billNo, currency: 'INR' })
    : null;

  const whatsappUrl = String(settings?.whatsapp_url || settings?.whatsappUrl || '').trim();
  const instagramLink = String(settings?.instagram_link || settings?.instagramLink || '').trim();
  const facebookUrl = String(settings?.facebook_url || settings?.facebookUrl || '').trim();

  const socialItems = [
    whatsappUrl && { label: 'WhatsApp', url: whatsappUrl },
    instagramLink && { label: 'Instagram', url: instagramLink },
    facebookUrl && { label: 'Facebook', url: facebookUrl }
  ].filter(Boolean);

  const [upiQrBuffer, ...socialQrBuffers] = await Promise.all([
    upiUri ? generateQrBuffer(upiUri, 120) : null,
    ...socialItems.map((s) => generateQrBuffer(s.url, 100))
  ]);

  const hasUpiQr = Boolean(upiQrBuffer && vpa);
  const validSocialQrs = socialItems
    .map((item, idx) => ({ ...item, buffer: socialQrBuffers[idx] }))
    .filter((s) => Boolean(s.buffer));

  if (hasUpiQr || validSocialQrs.length > 0) {
    const qrBoxHeight = 56;
    if (y + qrBoxHeight < pageHeight - 80) {
      // Draw dashed white box
      doc.save();
      doc.rect(margin, y, contentWidth, qrBoxHeight);
      doc.strokeColor('#999999').lineWidth(1).dash(2.5, { space: 2.5 }).stroke();
      doc.restore();

      // Left: UPI Payment QR
      let leftWidth = 0;
      if (hasUpiQr) {
        doc.image(upiQrBuffer, margin + 6, y + 5, { fit: [46, 46] });
        doc.font(fontBold).fontSize(5.8).fillColor('#555555')
          .text('SCAN TO PAY (UPI)', margin + 58, y + 9);
        doc.font(fontBold).fontSize(7).fillColor('#111111')
          .text(`UPI: ${vpa}`, margin + 58, y + 19, { width: 175, ellipsis: true });
        doc.font(fontRegular).fontSize(6).fillColor('#666666')
          .text(due > 0 ? 'Remaining Due to Pay' : 'Amount pre-filled to pay', margin + 58, y + 31);
        leftWidth = 235;
      }

      // Right: Social Media QR codes (WhatsApp, Instagram, Facebook)
      if (validSocialQrs.length > 0) {
        const qrSize = 34;
        const colWidth = qrSize + 14;
        const totalSocialWidth = validSocialQrs.length * colWidth;
        let startX = margin + contentWidth - totalSocialWidth - 8;
        if (startX < margin + leftWidth) {
          startX = margin + leftWidth + 4;
        }

        validSocialQrs.forEach((sqr, i) => {
          const itemX = startX + i * colWidth;
          doc.image(sqr.buffer, itemX + 2, y + 5, { fit: [qrSize, qrSize] });
          doc.font(fontBold).fontSize(5.8).fillColor('#555555')
            .text(sqr.label.toUpperCase(), itemX - 2, y + 42, { width: qrSize + 8, align: 'center' });
        });
      }

      y += qrBoxHeight + 8;
    }
  }

  // 5.1 Bilingual Security Deposit Policy Note
  if (isBooking && secDeposit > 0 && y < pageHeight - 95) {
    const formattedDep = cur(secDeposit);
    const engText = depositPaid
      ? `Security deposit of ${formattedDep} is held separately and is not included in this bill.`
      : `Security deposit of ${formattedDep} is pending and must be paid at pickup/handover.`;
    const gujText = depositPaid
      ? `${formattedDep} ની સિક્યોરિટી ડિપોઝિટ અલગથી રાખવામાં આવે છે અને તે આ બિલમાં શામેલ નથી.`
      : `${formattedDep} ની સિક્યોરિટી ડિપોઝિટ બાકી છે અને પીકઅપ/ડિલિવરી વખતે ચૂકવવાની રહેશે.`;

    const noteBoxY = y;
    doc.save();
    doc.roundedRect(margin, noteBoxY, contentWidth, 24, 3)
      .fillColor(depositPaid ? '#F0FDF4' : '#FFFBEB')
      .strokeColor(depositPaid ? '#BBF7D0' : '#FDE68A')
      .lineWidth(0.5)
      .fillAndStroke();
    doc.restore();

    doc.font(fontRegular).fontSize(6.8).fillColor(depositPaid ? '#166534' : '#92400E')
      .text(engText, margin + 8, noteBoxY + 3.5, { width: contentWidth - 16 });
    doc.font(fontRegular).fontSize(6.8).fillColor(depositPaid ? '#166534' : '#92400E')
      .text(gujText, margin + 8, noteBoxY + 12.5, { width: contentWidth - 16 });

    y = noteBoxY + 30;
  }

  // 6. Notes & Terms & Conditions
  const notes = record?.notes || '';
  if (notes && y < pageHeight - 80) {
    doc.font(fontBold).fontSize(6.4).fillColor('#444444').text('NOTES', margin, y);
    y += 8;
    doc.font(fontRegular).fontSize(7.2).fillColor('#333333').text(notes, margin, y, { width: contentWidth, lineGap: 1.5 });
    y = doc.y + 6;
  }

  const terms = settings?.terms_and_conditions || settings?.termsAndConditions || '';
  if (terms && y < pageHeight - 75) {
    doc.font(fontBold).fontSize(6.4).fillColor('#444444').text('TERMS & CONDITIONS', margin, y);
    y += 8;
    doc.font(fontRegular).fontSize(6.8).fillColor('#333333').text(terms, margin, y, { width: contentWidth, lineGap: 2.2 });
    y = doc.y + 6;
  }

  const footerNote = settings?.bill_footer_note || settings?.billFooterNote;
  if (footerNote && y < pageHeight - 75) {
    doc.font(fontRegular).fontSize(6.8).fillColor('#555555').text(footerNote, margin, y, { width: contentWidth, lineGap: 1.5 });
    y = doc.y + 6;
  }

  // 7. Thank you & Authorized Signatory
  const showSignature = settings?.bill_show_signature !== false && settings?.billShowSignature !== false;
  const signatoryDividerY = pageHeight - 52;
  const signatoryTextY = pageHeight - 44;

  doc.save();
  doc.moveTo(margin, signatoryDividerY).lineTo(margin + contentWidth, signatoryDividerY);
  doc.strokeColor('#999999').lineWidth(1).dash(2.5, { space: 2.5 }).stroke();
  doc.restore();

  // Prevent auto-pagebreak on fixed bottom footer
  doc.page.margins.bottom = 0;

  doc.font(fontBold).fontSize(7.4).fillColor('#111111')
    .text(`Thank you for choosing ${companyName}.`, margin, signatoryTextY, { lineBreak: false });
  const storePhone = settings?.phone_number || settings?.phoneNumber;
  if (storePhone) {
    doc.font(fontRegular).fontSize(6.8).fillColor('#666666')
      .text(`Contact: ${storePhone}`, margin, signatoryTextY + 10, { lineBreak: false });
  }

  if (showSignature) {
    const signWidth = 105;
    const signX = margin + contentWidth - signWidth;
    doc.strokeColor('#111111').lineWidth(1).moveTo(signX, signatoryTextY + 9).lineTo(signX + signWidth, signatoryTextY + 9).stroke();
    doc.font(fontRegular).fontSize(6.6).fillColor('#444444')
      .text('Authorized Signature', signX, signatoryTextY + 11, { width: signWidth, align: 'center', lineBreak: false });
  }

  // --------------------------------------------------------------------------
  // PAGE 2+: PRODUCT IMAGES GALLERY (Included in shared PDF)
  // Only the single primary image per product is shown (image2 is excluded)
  // --------------------------------------------------------------------------
  const productsWithImages = [];
  for (const it of items) {
    const rawImages = [
      ...parseProductImages(it.product?.image),
      ...parseProductImages(it.product_image),
      ...parseProductImages(it.productImage)
    ];
    const uniqueImages = [...new Set(rawImages)];
    const primaryImage = uniqueImages[0];
    if (primaryImage) {
      productsWithImages.push({
        name: it.product_name || it.productName || it.product?.productName || 'Item',
        code: it.product_code || it.productCode || it.product?.productCode || '',
        imageUrl: primaryImage
      });
    }
  }

  if (productsWithImages.length > 0) {
    const resolvedImages = await Promise.all(
      productsWithImages.map(async (p) => {
        const buffer = await resolveImageBuffer(p.imageUrl);
        return { ...p, buffer };
      })
    );

    const ITEMS_PER_PAGE = 4;
    const totalPages = Math.ceil(resolvedImages.length / ITEMS_PER_PAGE);

    for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
      doc.addPage({ size: 'A4', margin: 24 });
      doc.x = margin;
      doc.y = margin;

      const pageItems = resolvedImages.slice(pageIdx * ITEMS_PER_PAGE, (pageIdx + 1) * ITEMS_PER_PAGE);

      // Gallery Page Header
      let pageY = margin;
      doc.font(fontBold).fontSize(10).fillColor('#0F172A')
        .text('ATTACHED PRODUCT IMAGES', margin, pageY);

      doc.font(fontRegular).fontSize(7.5).fillColor('#334155')
        .text(`Bill No: ${billNo}`, margin + contentWidth - 160, pageY + 1.5, { width: 160, align: 'right' });
      pageY += 18;

      doc.strokeColor('#1E293B').lineWidth(1.5).moveTo(margin, pageY).lineTo(margin + contentWidth, pageY).stroke();
      pageY += 12;

      // 2 columns x 2 rows
      const gridGap = 14;
      const cardWidth = (contentWidth - gridGap) / 2;
      const cardHeight = (pageHeight - pageY - 32 - gridGap) / 2;
      const imgHeight = cardHeight - 44;

      for (let i = 0; i < pageItems.length; i++) {
        const item = pageItems[i];
        const col = i % 2;
        const row = Math.floor(i / 2);
        const cardX = margin + col * (cardWidth + gridGap);
        const cardY = pageY + row * (cardHeight + gridGap);

        // Card border & background
        doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 8)
          .strokeColor('#E2E8F0').lineWidth(1).fillAndStroke('#FFFFFF', '#E2E8F0');

        // Image container area
        const imgBoxX = cardX + 6;
        const imgBoxY = cardY + 6;
        const imgBoxWidth = cardWidth - 12;
        const imgBoxHeight = imgHeight;

        doc.roundedRect(imgBoxX, imgBoxY, imgBoxWidth, imgBoxHeight, 6).fill('#F8FAFC');

        if (item.buffer) {
          try {
            doc.image(item.buffer, imgBoxX + 4, imgBoxY + 4, {
              fit: [imgBoxWidth - 8, imgBoxHeight - 8],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            console.warn('[PDFKit] Image display error:', imgErr.message);
            doc.font(fontRegular).fontSize(7.5).fillColor('#9CA3AF')
              .text('Image format not supported', imgBoxX, imgBoxY + imgBoxHeight / 2 - 5, { width: imgBoxWidth, align: 'center' });
          }
        } else {
          doc.font(fontRegular).fontSize(7.5).fillColor('#9CA3AF')
            .text('Image Preview Not Available', imgBoxX, imgBoxY + imgBoxHeight / 2 - 5, { width: imgBoxWidth, align: 'center' });
        }

        // Caption: Product name and Product code
        const captionY = cardY + imgHeight + 9;
        doc.font(fontBold).fontSize(8).fillColor('#1E293B')
          .text(item.name, cardX + 6, captionY, { width: cardWidth - 12, align: 'center', ellipsis: true });

        if (item.code) {
          doc.font(fontRegular).fontSize(6.8).fillColor('#475569')
            .text(`Code: ${item.code}`, cardX + 6, captionY + 11, { width: cardWidth - 12, align: 'center' });
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // GLOBAL FOOTER: KAPADKART BRANDING, DIGITAL LINK & PAGE NUMBERS ON EVERY PAGE
  // --------------------------------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;

    const hasDigitalUrl = Boolean(digitalInvoiceUrl);
    const dividerY = hasDigitalUrl ? pageHeight - 27 : pageHeight - 24;
    const line1Y = hasDigitalUrl ? pageHeight - 22 : pageHeight - 17.5;
    const badgeY = hasDigitalUrl ? pageHeight - 23.5 : pageHeight - 19;

    // Top divider line for footer
    doc.strokeColor('#E2E8F0').lineWidth(0.75)
      .moveTo(margin, dividerY)
      .lineTo(margin + contentWidth, dividerY)
      .stroke();

    // KapadKart Amber Badge with 'K'
    const badgeX = margin;
    const badgeSize = 11;
    doc.roundedRect(badgeX, badgeY, badgeSize, badgeSize, 2).fill('#D97706');
    doc.font(fontBold).fontSize(7).fillColor('#FFFFFF')
      .text('K', badgeX, badgeY + 1.6, { width: badgeSize, align: 'center', lineBreak: false });

    // "Powered by KapadKart — Smart Rental & Retail Software • www.kapadkart.in"
    const textX = badgeX + badgeSize + 4;
    doc.font(fontBold).fontSize(7).fillColor('#111111')
      .text('Powered by KapadKart', textX, line1Y, { lineBreak: false });

    const brandWidth = doc.widthOfString('Powered by KapadKart');
    doc.font(fontRegular).fontSize(7).fillColor('#666666')
      .text(' — Smart Rental & Retail Software • www.kapadkart.in', textX + brandWidth, line1Y, { lineBreak: false });

    // Dynamic Page Number on right
    doc.font(fontRegular).fontSize(7).fillColor('#666666')
      .text(`Page ${i + 1} of ${range.count}`, margin + contentWidth - 100, line1Y, {
        width: 100,
        align: 'right',
        lineBreak: false
      });

    // Digital Invoice URL on line 2 if available
    if (hasDigitalUrl) {
      const line2Y = pageHeight - 11.5;
      doc.font(fontBold).fontSize(6.5).fillColor('#64748B')
        .text('Digital Bill: ', margin, line2Y, { lineBreak: false });
      const labelW = doc.widthOfString('Digital Bill: ');
      doc.font(fontRegular).fontSize(6.5).fillColor('#0F172A')
        .text(digitalInvoiceUrl, margin + labelW, line2Y, {
          width: contentWidth - labelW - 10,
          ellipsis: true,
          lineBreak: false
        });
    }
  }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Stream a complete Bill PDF using PDFKit to an Express HTTP response.
 * Sends full Content-Length and RFC 5987 / RFC 6266 headers for direct download
 * across all mobile (iOS, Android) and desktop (Mac, Windows, Linux) browsers.
 *
 * @param {Object} options
 * @param {Object} options.record - Sale or Booking object with items
 * @param {'sale'|'booking'} options.type - 'sale' or 'booking'
 * @param {Object} options.settings - Tenant settings / branding
 * @param {string|null} [options.token] - Public share token
 * @param {string} [options.fileName] - Name of PDF file
 * @param {'attachment'|'inline'} [options.disposition] - Content disposition
 * @param {import('express').Response} options.res - HTTP response stream
 */
export async function streamBillPdf({
  record,
  type = 'sale',
  settings = {},
  token = null,
  fileName = 'Invoice.pdf',
  disposition = 'attachment',
  res
}) {
  const pdfBuffer = await generateBillPdfBuffer({ record, type, settings, token });

  if (!res.headersSent) {
    const safeAscii = String(fileName || 'Invoice.pdf').replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(String(fileName || 'Invoice.pdf'));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encoded}`
    );
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  res.end(pdfBuffer);
}


