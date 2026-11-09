import bcrypt from 'bcryptjs';

const PLATFORM_ADMIN = {
  username: 'kapadkart',
  email: 'admin@kapadkart.com',
  password: 'Admin123',
  fullName: 'Platform Administrator',
};

const TEST_SHOP = {
  slug: 'khodal-mahakali-shop',
  name: 'khodal-mahakali-shop',
  businessType: 'SALES_AND_RENTAL',
  companyName: 'khodal-mahakali-shop',
  pageTitle: 'khodal-mahakali-shop',
  phoneNumber: '7227807493',
  ownerEmail: 'khodal@kapadkart.com',
  ownerPassword: 'Khodal@123',
  ownerName: 'mahakali',
};

/**
 * Insert or update the platform admin and the Khodal test shop.
 * The caller owns the transaction.
 */
export async function seedInitialAccounts(client) {
  const adminPasswordHash = await bcrypt.hash(PLATFORM_ADMIN.password, 10);
  const adminRes = await client.query(
    `
    INSERT INTO app.platform_admins (username, email, password_hash, full_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (username)
    DO UPDATE SET
      email = EXCLUDED.email,
      password_hash = EXCLUDED.password_hash,
      full_name = EXCLUDED.full_name,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, auth_key, username, email, full_name;
    `,
    [PLATFORM_ADMIN.username, PLATFORM_ADMIN.email, adminPasswordHash, PLATFORM_ADMIN.fullName]
  );
  const platformAdmin = adminRes.rows[0];

  const shopPasswordHash = await bcrypt.hash(TEST_SHOP.ownerPassword, 10);
  const tenantRes = await client.query(
    `
    INSERT INTO app.tenants (
      slug, original_slug, name, status, business_type, created_by, created_by_admin_id
    )
    VALUES ($1, $1, $2, 'active', $3::app.business_type, $4, $5)
    ON CONFLICT (slug)
    DO UPDATE SET
      name = EXCLUDED.name,
      status = 'active',
      business_type = EXCLUDED.business_type,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, slug, name, auth_key;
    `,
    [
      TEST_SHOP.slug,
      TEST_SHOP.name,
      TEST_SHOP.businessType,
      PLATFORM_ADMIN.email,
      platformAdmin.id,
    ]
  );
  const shop = tenantRes.rows[0];

  await client.query(
    `
    INSERT INTO app.settings (tenant_id, company_name, page_title, phone_number)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      company_name = EXCLUDED.company_name,
      page_title = EXCLUDED.page_title,
      phone_number = EXCLUDED.phone_number,
      updated_at = CURRENT_TIMESTAMP;
    `,
    [shop.id, TEST_SHOP.companyName, TEST_SHOP.pageTitle, TEST_SHOP.phoneNumber]
  );

  const userRes = await client.query(
    `
    INSERT INTO app.users (tenant_id, email, original_email, password_hash, full_name)
    VALUES ($1, $2, $2, $3, $4)
    ON CONFLICT (tenant_id, email)
    DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      full_name = EXCLUDED.full_name,
      original_email = EXCLUDED.original_email,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, email, full_name;
    `,
    [shop.id, TEST_SHOP.ownerEmail, shopPasswordHash, TEST_SHOP.ownerName]
  );
  const owner = userRes.rows[0];

  return { platformAdmin, shop, owner };
}
