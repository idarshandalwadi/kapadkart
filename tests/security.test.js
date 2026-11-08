import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import { closeDatabasePool, query } from '../src/config/db.js';
import { disconnectPrisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import { generateToken, revokeToken } from '../src/utils/token.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Comprehensive Authentication & Authorization Security Tests', () => {
  let server;
  let baseUrl;
  let adminToken = '';
  let tenantToken = '';
  let tenantUser = null;

  before(async () => {
    await ensureTestTenant();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // Obtain Admin Token
    const adminLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@reantario.com', password: 'Admin123' })
    });
    const adminLoginData = await adminLoginRes.json();
    adminToken = adminLoginData.token;

    // Obtain Tenant Token
    const tenantLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });
    const tenantLoginData = await tenantLoginRes.json();
    tenantToken = tenantLoginData.token;
    tenantUser = tenantLoginData.user;
  });

  after(async () => {
    await Promise.allSettled([
      closeDatabasePool(),
      disconnectPrisma()
    ]);
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  // 1. TAMPERED & FORGED SIGNATURES
  it('Rejects JWT with tampered payload or forged signature with 401', async () => {
    // Generate token signed with wrong secret
    const forgedToken = jwt.sign(
      { sub: tenantUser.id, role: 'tenant_user', tenant_slug: 'khodal-mahakali-shop' },
      'wrong_fake_secret_key_attack',
      { algorithm: 'HS256' }
    );

    const res = await fetch(`${baseUrl}/api/v1/tenant/overview`, {
      headers: { Authorization: `Bearer ${forgedToken}` }
    });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.code, 'TOKEN_INVALID');
  });

  // 2. REJECTS LEGACY PLAINTEXT PSEUDO-TOKENS
  it('Strictly rejects legacy plaintext tokens (token_user_ / token_admin_) with 401', async () => {
    const fakeLegacyToken = `token_user_${tenantUser.id}`;
    const res = await fetch(`${baseUrl}/api/v1/tenant/overview`, {
      headers: { Authorization: `Bearer ${fakeLegacyToken}` }
    });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.code, 'TOKEN_INVALID');

    const fakeAdminLegacyToken = `token_admin_random-uuid`;
    const adminRes = await fetch(`${baseUrl}/api/v1/admin/overview`, {
      headers: { Authorization: `Bearer ${fakeAdminLegacyToken}` }
    });
    assert.equal(adminRes.status, 401);
  });

  // 3. EXPIRED TOKEN REJECTION
  it('Strictly rejects expired JWT tokens with 401 and TOKEN_EXPIRED code', async () => {
    const expiredToken = jwt.sign(
      { sub: tenantUser.id, role: 'tenant_user', tenant_slug: 'khodal-mahakali-shop' },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '-10s' }
    );

    const res = await fetch(`${baseUrl}/api/v1/tenant/overview`, {
      headers: { Authorization: `Bearer ${expiredToken}` }
    });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.code, 'TOKEN_EXPIRED');
  });

  // 4. SERVER-SIDE REVOCATION ENFORCEMENT
  it('Rejects explicitly revoked tokens via server-side blacklist with 401 TOKEN_REVOKED', async () => {
    const { token, jti } = generateToken({
      sub: tenantUser.id,
      role: 'tenant_user',
      tenant_slug: 'khodal-mahakali-shop'
    });

    // Before revocation: request succeeds
    const beforeRes = await fetch(`${baseUrl}/api/v1/tenant/overview`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(beforeRes.status, 200);

    // Revoke token
    await revokeToken(jti, tenantUser.id, Date.now() + 3600000);

    // After revocation: must fail with 401 TOKEN_REVOKED
    const afterRes = await fetch(`${baseUrl}/api/v1/tenant/overview`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const afterBody = await afterRes.json();
    assert.equal(afterRes.status, 401);
    assert.equal(afterBody.code, 'TOKEN_REVOKED');
  });

  // 5. TENANT BOUNDARY ENFORCEMENT & ISOLATION
  it('Enforces strict tenant boundaries and blocks cross-tenant access with 403', async () => {
    // Tenant user attempts to pass a different tenant slug in header
    const res = await fetch(`${baseUrl}/api/v1/tenant/overview`, {
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'X-Tenant-Slug': 'unauthorized-other-shop'
      }
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.ok(body.message.includes('Tenant boundary mismatch'));
  });

  // 6. ROLE PRIVILEGE ESCALATION PREVENTION
  it('Prevents tenant user from accessing platform admin endpoints with 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/overview`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.ok(body.message.includes('Platform Administrator privilege required'));
  });

  // 7. ACCOUNT ENUMERATION DEFENSE & GENERIC RESPONSE
  it('Returns identical generic response for registered and unregistered accounts in forgot-password', async () => {
    // Clear prior OTPs so this is a fresh request outside cooldown
    await query(`DELETE FROM app.password_reset_otps WHERE email = 'khodal@reantario.com';`);

    const existingRes = await fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com' })
    });
    const existingBody = await existingRes.json();
    assert.equal(existingRes.status, 200);

    const nonExistingRes = await fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'does-not-exist@random-domain-test.com' })
    });
    const nonExistingBody = await nonExistingRes.json();
    assert.equal(nonExistingRes.status, 200);

    // Messages and structure must be identical and generic
    const expectedGenericMsg = 'If an account matches the information provided, you will receive an email with further instructions.';
    assert.equal(existingBody.message, expectedGenericMsg);
    assert.equal(nonExistingBody.message, expectedGenericMsg);
    assert.equal(existingBody.data.otp_length, 6);
    assert.equal(nonExistingBody.data.otp_length, 6);
    assert.equal(existingBody.data.resend_cooldown, 120);
    assert.equal(nonExistingBody.data.resend_cooldown, 120);
  });

  // 8. 2-MINUTE OTP RESEND COOLDOWN ENFORCEMENT & CONCURRENCY
  it('Enforces 2-minute cooldown on OTP resend requests with 429', async () => {
    // Immediate second request for same user must be blocked by cooldown
    const secondReq = await fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com' })
    });
    const body = await secondReq.json();
    assert.equal(secondReq.status, 429);
    assert.equal(body.code, 'OTP_COOLDOWN_ACTIVE');
    assert.ok(body.retry_after_seconds > 0 && body.retry_after_seconds <= 120);
  });

  it('Prevents concurrent OTP requests from bypassing the 2-minute cooldown', async () => {
    // Clean prior OTPs to test fresh parallel burst
    await query(`DELETE FROM app.password_reset_otps WHERE email = 'khodal@reantario.com';`);

    // Fire 3 simultaneous requests
    const results = await Promise.all([
      fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'khodal@reantario.com' })
      }),
      fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'khodal@reantario.com' })
      }),
      fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'khodal@reantario.com' })
      })
    ]);

    const statuses = results.map((r) => r.status);
    // Exactly 1 must succeed with 200, others must be rejected with 429
    const successCount = statuses.filter((s) => s === 200).length;
    const cooldownCount = statuses.filter((s) => s === 429).length;

    assert.equal(successCount, 1);
    assert.equal(cooldownCount, 2);
  });

  // 9. DAILY PASSWORD CHANGE RATE LIMIT (MAX 5 PER USER PER CALENDAR DAY UTC)
  it('Enforces daily password change limit (max 5 per calendar day) across all endpoints with 429', async () => {
    // Clean up test change logs first
    await query(`DELETE FROM app.password_change_logs WHERE user_id = $1;`, [tenantUser.id]);

    // Insert 5 simulated password change logs for tenant user within today (UTC)
    for (let i = 0; i < 5; i++) {
      await query(
        `INSERT INTO app.password_change_logs (user_id, source, ip_address, changed_at)
         VALUES ($1, $2, '127.0.0.1', CURRENT_TIMESTAMP - INTERVAL '5 minutes');`,
        [tenantUser.id, i % 2 === 0 ? 'FORGOT_PASSWORD_RESET' : 'CHANGE_PASSWORD']
      );
    }

    // Attempting 6th password change must return 429 with standard generic user message
    const changeRes = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        current_password: 'Khodal@123',
        new_password: 'NewSecurePassword@123',
        confirm_new_password: 'NewSecurePassword@123'
      })
    });

    const changeBody = await changeRes.json();
    assert.equal(changeRes.status, 429);
    assert.equal(changeBody.code, 'DAILY_PASSWORD_CHANGE_LIMIT_REACHED');
    assert.equal(changeBody.message, "You have reached today's password change limit. Please try again after the daily limit resets.");

    // Clean up test change logs
    await query(`DELETE FROM app.password_change_logs WHERE user_id = $1;`, [tenantUser.id]);
  });

  it('Failed password change attempts do not count toward the daily limit', async () => {
    await query(`DELETE FROM app.password_change_logs WHERE user_id = $1;`, [tenantUser.id]);

    // Attempt change with incorrect current password
    const failRes = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        current_password: 'WrongCurrentPassword!123',
        new_password: 'NewSecurePassword@123',
        confirm_new_password: 'NewSecurePassword@123'
      })
    });
    assert.equal(failRes.status, 400);

    // Verify counter in app.password_change_logs remains 0
    const countRes = await query(
      `SELECT count(*)::int as count FROM app.password_change_logs WHERE user_id = $1;`,
      [tenantUser.id]
    );
    assert.equal(countRes.rows[0].count, 0);
  });

  // 10. NEW SHOP REGISTRATION, OWNER USER CREATION & WELCOME EMAIL DISPATCH
  it('Admin shop creation creates owner user in app.users and logs welcome email', async () => {
    const testSlug = `shop-test-${Date.now()}`;
    const testEmail = `owner-${Date.now()}@kapadkart-test.com`;

    const createRes = await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Auto Test Shop',
        slug: testSlug,
        phone_number: '9876543210',
        address: '123 Test Street, Surat',
        currency: 'INR',
        owner_email: testEmail,
        owner_full_name: 'Test Shop Owner',
        owner_password: 'TestPassword@123'
      })
    });

    const createBody = await createRes.json();
    assert.equal(createRes.status, 201);
    assert.equal(createBody.status, 'success');
    assert.ok(createBody.data.id);
    assert.equal(createBody.data.owner?.email, testEmail);

    // Verify owner user in app.users
    const userCheck = await query(`SELECT id, email, full_name FROM app.users WHERE email = $1;`, [testEmail]);
    assert.equal(userCheck.rows.length, 1);
    assert.equal(userCheck.rows[0].full_name, 'Test Shop Owner');

    // Verify email log in app.email_logs
    const emailCheck = await query(
      `SELECT * FROM app.email_logs WHERE to_address = $1 AND template_name = 'welcome_shop';`,
      [testEmail]
    );
    assert.equal(emailCheck.rows.length, 1);

    // Verify admin can fetch logs via GET /api/v1/emails/logs
    const logsRes = await fetch(`${baseUrl}/api/v1/emails/logs?search=${encodeURIComponent(testEmail)}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const logsBody = await logsRes.json();
    assert.equal(logsRes.status, 200);
    assert.ok(logsBody.data.items.length >= 1);

    // Clean up created test tenant and user
    await query(`DELETE FROM app.tenants WHERE slug = $1;`, [testSlug]);
  });

  // 11. IMMUTABLE SHOP EMAIL ADDRESS (SERVER-SIDE ENFORCEMENT)
  it('Rejects any attempt to change shop owner email via PUT /tenants/:slug with 400 EMAIL_IMMUTABLE', async () => {
    const testSlug = `immut-shop-${Date.now()}`;
    const originalEmail = `immutable-${Date.now()}@kapadkart-test.com`;
    const attemptedEmail = `hacked-${Date.now()}@kapadkart-test.com`;

    // Create a shop first
    await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Immutable Email Test Shop',
        slug: testSlug,
        owner_email: originalEmail,
        owner_full_name: 'Original Owner'
      })
    });

    // Attempt to change owner_email via PUT
    const updateRes = await fetch(`${baseUrl}/api/v1/admin/tenants/${testSlug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Immutable Email Test Shop Updated',
        owner_email: attemptedEmail
      })
    });

    const updateBody = await updateRes.json();
    assert.equal(updateRes.status, 400);
    assert.equal(updateBody.code, 'EMAIL_IMMUTABLE');

    // Verify in database that email was NOT changed
    const userCheck = await query(`SELECT email FROM app.users WHERE email = $1;`, [originalEmail]);
    assert.equal(userCheck.rows.length, 1);
    const hackedCheck = await query(`SELECT email FROM app.users WHERE email = $1;`, [attemptedEmail]);
    assert.equal(hackedCheck.rows.length, 0);

    // Clean up
    await query(`DELETE FROM app.tenants WHERE slug = $1;`, [testSlug]);
  });

  // 12. CREATED_BY TRACKING & OWNER IN TENANT LISTING
  it('Persists created_by admin email/id and returns owner object in listing', async () => {
    const testSlug = `creator-shop-${Date.now()}`;
    const ownerEmail = `creator-owner-${Date.now()}@kapadkart-test.com`;

    const createRes = await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Creator Tracking Shop',
        slug: testSlug,
        owner_email: ownerEmail,
        owner_full_name: 'Creator Test Owner'
      })
    });
    assert.equal(createRes.status, 201);

    // Verify app.tenants has created_by set to admin@reantario.com
    const tenantCheck = await query(`SELECT created_by, created_by_admin_id FROM app.tenants WHERE slug = $1;`, [testSlug]);
    assert.equal(tenantCheck.rows[0].created_by, 'admin@reantario.com');
    assert.ok(tenantCheck.rows[0].created_by_admin_id);

    // Verify GET /api/v1/admin/tenants returns created_by and owner object with email & full_name
    const listRes = await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const listBody = await listRes.json();
    assert.equal(listRes.status, 200);

    const foundShop = listBody.data.find((s) => s.slug === testSlug);
    assert.ok(foundShop, 'Shop should be present in listing');
    assert.equal(foundShop.created_by, 'admin@reantario.com');
    assert.ok(foundShop.owner, 'Owner object must be present in listing response');
    assert.equal(foundShop.owner.email, ownerEmail);
    assert.equal(foundShop.owner.full_name, 'Creator Test Owner');

    // Clean up
    await query(`DELETE FROM app.tenants WHERE slug = $1;`, [testSlug]);
  });

  // 13. ACCOUNT_UPDATED NOTIFICATION EMAIL
  it('Dispatches account_updated email when admin modifies profile details', async () => {
    const testSlug = `update-shop-${Date.now()}`;
    const ownerEmail = `owner-update-${Date.now()}@kapadkart-test.com`;

    await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Update Email Shop',
        slug: testSlug,
        owner_email: ownerEmail,
        owner_full_name: 'Original Full Name'
      })
    });

    // Update shop name and company_name
    const updateRes = await fetch(`${baseUrl}/api/v1/admin/tenants/${testSlug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Update Email Shop Changed',
        company_name: 'New Company Corp',
        address: '456 New Street, Surat'
      })
    });
    assert.equal(updateRes.status, 200);

    // Verify account_updated in app.email_logs
    const emailCheck = await query(
      `SELECT * FROM app.email_logs WHERE to_address = $1 AND template_name = 'account_updated';`,
      [ownerEmail]
    );
    assert.equal(emailCheck.rows.length, 1);
    assert.ok(emailCheck.rows[0].metadata?.updated_fields?.includes('Shop Name'));

    // Clean up
    await query(`DELETE FROM app.tenants WHERE slug = $1;`, [testSlug]);
  });

  // 14. ACCOUNT_SUSPENDED NOTIFICATION EMAIL WITH CUSTOM REASON
  it('Dispatches account_suspended email with reason when status transitions to suspended', async () => {
    const testSlug = `suspend-shop-${Date.now()}`;
    const ownerEmail = `owner-suspend-${Date.now()}@kapadkart-test.com`;

    await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Suspension Email Shop',
        slug: testSlug,
        owner_email: ownerEmail,
        owner_full_name: 'Suspended Owner'
      })
    });

    // Patch status to suspended with reason
    const patchRes = await fetch(`${baseUrl}/api/v1/admin/tenants/${testSlug}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        status: 'suspended',
        reason: 'Outstanding Payment',
        customReason: 'Invoice #INV-2026-001 overdue by 30 days.'
      })
    });
    assert.equal(patchRes.status, 200);

    // Verify account_suspended in app.email_logs
    const emailCheck = await query(
      `SELECT * FROM app.email_logs WHERE to_address = $1 AND template_name = 'account_suspended';`,
      [ownerEmail]
    );
    assert.equal(emailCheck.rows.length, 1);
    assert.equal(emailCheck.rows[0].metadata?.reason, 'Outstanding Payment');

    // Clean up
    await query(`DELETE FROM app.tenants WHERE slug = $1;`, [testSlug]);
  });

  // 15. OPTION 2: SOFT DELETE IMMEDIATELY RELEASES SLUG & EMAIL FOR NEW REGISTRATION
  it('Option 2: Soft delete releases slug and email so new client can register identical slug and email', async () => {
    const slug = `mahadev-${Date.now()}`;
    const email = `mahadev-${Date.now()}@gmail.com`;

    // 1. Create initial shop
    const create1Res = await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Mahadev Shop 1',
        slug,
        owner_email: email,
        owner_full_name: 'Original Mahadev'
      })
    });
    assert.equal(create1Res.status, 201);
    const shop1Data = await create1Res.json();
    const originalTenantId = shop1Data.data.id;

    // 2. Soft-delete the initial shop
    const deleteRes = await fetch(`${baseUrl}/api/v1/admin/tenants/${slug}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });
    assert.equal(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.equal(deleteData.data.status, 'deleted');
    assert.equal(deleteData.data.original_slug, slug);
    assert.ok(deleteData.data.slug.startsWith(`${slug}-deleted-`), 'Expected slug to have -deleted- suffix');

    // Verify user email was archived in database
    const userDbRes = await query(`SELECT email, original_email FROM app.users WHERE tenant_id = $1;`, [originalTenantId]);
    assert.equal(userDbRes.rows[0].original_email, email);
    assert.ok(userDbRes.rows[0].email.includes('-deleted-'), 'Expected user email to have -deleted- suffix');

    // 3. New client registers new shop with the EXACT SAME slug and email
    const create2Res = await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Mahadev New Client Shop',
        slug,
        owner_email: email,
        owner_full_name: 'New Mahadev Owner'
      })
    });
    assert.equal(create2Res.status, 201, 'New shop with same slug & email should succeed without duplicate key error');
    const shop2Data = await create2Res.json();
    const newTenantId = shop2Data.data.id;
    assert.equal(shop2Data.data.slug, slug);

    // 4. Try to restore the original deleted shop while new shop is holding the slug -> Expect 409 Conflict
    const restoreConflictRes = await fetch(`${baseUrl}/api/v1/admin/tenants/${deleteData.data.slug}/restore`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });
    assert.equal(restoreConflictRes.status, 409, 'Restoring should return 409 Conflict when slug is held by active shop');
    const conflictBody = await restoreConflictRes.json();
    assert.equal(conflictBody.code, 'SLUG_CONFLICT');

    // 5. Delete the new shop, then restore the original shop -> Should succeed!
    const delete2Res = await fetch(`${baseUrl}/api/v1/admin/tenants/${slug}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });
    assert.equal(delete2Res.status, 200);

    const restoreSuccessRes = await fetch(`${baseUrl}/api/v1/admin/tenants/${deleteData.data.slug}/restore`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });
    assert.equal(restoreSuccessRes.status, 200);
    const restoredData = await restoreSuccessRes.json();
    assert.equal(restoredData.data.slug, slug);
    assert.equal(restoredData.data.status, 'active');

    // Clean up
    await query(`DELETE FROM app.tenants WHERE id IN ($1, $2);`, [originalTenantId, newTenantId]);
  });
});
