import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/config/prisma.js';
import { closeDatabasePool } from '../src/config/db.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Rental Accessories Price & Booking Edit Availability Tests', () => {
  let server;
  let baseUrl;
  let tenantToken = '';
  let tenantId = '';
  let testProductId = '';
  let createdBookingId = '';

  before(async () => {
    tenantId = await ensureTestTenant();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });
    const loginData = await loginRes.json();
    tenantToken = loginData.token;

    // Create 1 test product with totalQuantity: 1 (exact case from the user's report)
    const suffix = Date.now().toString().slice(-4);
    const p = await prisma.product.create({
      data: {
        tenantId,
        productName: 'Rental Sherwani Demo',
        productCode: `RS-${suffix}`,
        dailyRent: 1000,
        totalQuantity: 1,
        availabilityType: 'rent',
        category: 'Test'
      }
    });
    testProductId = p.id;
  });

  after(async () => {
    if (createdBookingId) {
      await prisma.bookingItem.deleteMany({ where: { bookingId: createdBookingId } });
      await prisma.booking.deleteMany({ where: { id: createdBookingId } });
    }
    if (testProductId) {
      await prisma.product.deleteMany({ where: { id: testProductId } });
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectPrisma();
    await closeDatabasePool();
  });

  it('1. POST /api/v1/tenant/bookings persists accessories_price and includes it in rentalTotal', async () => {
    const pickupDate = new Date();
    const returnDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const bookingPayload = {
      customer_name: 'Kanji Kanzariya',
      phone_number: '7656765678',
      village_address: 'Viramgam',
      pickup_date: pickupDate.toISOString(),
      return_date: returnDate.toISOString(),
      rental_days: 1,
      items: [
        {
          product_id: testProductId,
          quantity: 1,
          unit_rent: 1000,
          rental_days: 1,
          total_amount: 1000
        }
      ],
      accessories_price: 200,
      discount_amount: 50,
      tax_rate: 0,
      tax_amount: 0,
      paid_amount: 500,
      security_deposit: 500,
      deposit_paid: true,
      notes: 'Test booking with accessories and deposit'
    };

    const res = await fetch(`${baseUrl}/api/v1/tenant/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify(bookingPayload)
    });

    assert.equal(res.status, 201, 'Booking creation should return 201');
    const json = await res.json();
    assert.equal(json.status, 'success');
    assert.ok(json.data.id, 'Booking should have an ID');
    createdBookingId = json.data.id;

    // Check accessories_price persistence
    assert.equal(Number(json.data.accessories_price), 200, 'accessories_price must be 200');
    // Check security_deposit and deposit_paid persistence
    assert.equal(Number(json.data.security_deposit), 500, 'security_deposit must be 500');
    assert.equal(json.data.deposit_paid, true, 'deposit_paid must be true');
    // Check rental_total = 1000 + 200 - 50 = 1150
    assert.equal(Number(json.data.rental_total), 1150, 'rental_total must be 1150 (1000 + 200 - 50)');
    // Check due_amount = 1150 - 500 = 650
    assert.equal(Number(json.data.due_amount), 650, 'due_amount must be 650 (1150 - 500)');

    // Verify directly in DB
    const dbBooking = await prisma.booking.findUnique({ where: { id: createdBookingId } });
    assert.equal(Number(dbBooking.accessoriesPrice), 200, 'DB accessoriesPrice must be 200');
    assert.equal(Number(dbBooking.securityDeposit), 500, 'DB securityDeposit must be 500');
    assert.equal(dbBooking.depositPaid, true, 'DB depositPaid must be true');
    assert.equal(Number(dbBooking.rentalTotal), 1150, 'DB rentalTotal must be 1150');
    assert.equal(Number(dbBooking.dueAmount), 650, 'DB dueAmount must be 650');
  });

  it('2. GET /api/v1/tenant/products/:id with exclude_booking_id excludes own reservation', async () => {
    // Without exclude_booking_id, since totalQuantity = 1 and it is booked, available should be 0
    const resWithoutExclude = await fetch(`${baseUrl}/api/v1/tenant/products/${testProductId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(resWithoutExclude.status, 200);
    const dataWithout = await resWithoutExclude.json();
    assert.equal(dataWithout.data.available_quantity, 0, 'Available quantity should be 0 when booking is not excluded');

    // With exclude_booking_id = createdBookingId, available should be 1!
    const resWithExclude = await fetch(
      `${baseUrl}/api/v1/tenant/products/${testProductId}?exclude_booking_id=${createdBookingId}`,
      { headers: { Authorization: `Bearer ${tenantToken}` } }
    );
    assert.equal(resWithExclude.status, 200);
    const dataWith = await resWithExclude.json();
    assert.equal(
      dataWith.data.available_quantity,
      1,
      'Available quantity must be 1 when excluding the booking currently holding the reservation'
    );
  });

  it('3. PUT /api/v1/tenant/bookings/:id updates price and adjusts security deposit from 500 to 300', async () => {
    const pickupDate = new Date();
    const returnDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const updatePayload = {
      customer_name: 'Kanji Kanzariya (Updated)',
      phone_number: '7656765678',
      pickup_date: pickupDate.toISOString(),
      return_date: returnDate.toISOString(),
      rental_days: 1,
      items: [
        {
          product_id: testProductId,
          quantity: 1,
          unit_rent: 1200, // Price updated from 1000 to 1200
          rental_days: 1,
          total_amount: 1200
        }
      ],
      accessories_price: 250,
      discount_amount: 50,
      tax_rate: 0,
      tax_amount: 0,
      paid_amount: 500,
      security_deposit: 300,
      deposit_paid: true,
      notes: 'Customer paid 300 instead of 500 deposit at pickup'
    };

    const res = await fetch(`${baseUrl}/api/v1/tenant/bookings/${createdBookingId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify(updatePayload)
    });

    assert.equal(res.status, 200, 'PUT /bookings/:id should return 200');
    const json = await res.json();
    assert.equal(json.status, 'success');
    assert.equal(json.data.customer_name, 'Kanji Kanzariya (Updated)');
    assert.equal(Number(json.data.accessories_price), 250);
    assert.equal(Number(json.data.security_deposit), 300, 'security_deposit must be updated to 300');
    assert.equal(json.data.deposit_paid, true, 'deposit_paid must be true');
    // rental_total = 1200 + 250 - 50 = 1400
    assert.equal(Number(json.data.rental_total), 1400);
    // due_amount = 1400 - 500 = 900
    assert.equal(Number(json.data.due_amount), 900);

    // Verify GET /bookings/:id reflects 300 and deposit_paid: true
    const getRes = await fetch(`${baseUrl}/api/v1/tenant/bookings/${createdBookingId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(Number(getData.data.security_deposit), 300);
    assert.equal(getData.data.deposit_paid, true);
    assert.equal(Number(getData.data.deposit_collected), 300);
  });

  it('3b. PUT /api/v1/tenant/bookings/:id allows toggling deposit_paid to false (Pending)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/bookings/${createdBookingId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        security_deposit: 300,
        deposit_paid: false
      })
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(Number(json.data.security_deposit), 300);
    assert.equal(json.data.deposit_paid, false, 'deposit_paid must be false');
    assert.equal(Number(json.data.deposit_collected), 0);
  });

  it('4. Public PDF download link renders correctly with accessories_price included', async () => {
    // Generate share link
    const shareRes = await fetch(`${baseUrl}/api/v1/tenant/bookings/${createdBookingId}/share-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(shareRes.status, 200);
    const shareData = await shareRes.json();
    assert.ok(shareData.data.token, 'Should return a token');

    // Download PDF
    const pdfRes = await fetch(`${baseUrl}/api/v1/public/bills/download/${shareData.data.token}`);
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');

    const pdfBuffer = await pdfRes.arrayBuffer();
    assert.ok(pdfBuffer.byteLength > 1000, 'PDF buffer must contain binary PDF data');
  });

  it('5. DELETE /api/v1/tenant/bookings/:id deletes the booking successfully', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/bookings/${createdBookingId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, 'success');

    // Verify it is gone
    const checkRes = await fetch(`${baseUrl}/api/v1/tenant/bookings/${createdBookingId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(checkRes.status, 404);
    createdBookingId = null; // Prevent after() cleanup from failing
  });
});


