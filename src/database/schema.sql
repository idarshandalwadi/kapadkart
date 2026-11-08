-- ============================================================================
-- KAPADKART DATABASE SCHEMA
-- Fresh create script for schema "app". Run against an empty database.
-- IDs use gen_random_uuid(), which is built into PostgreSQL 13+.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS app;

-- ----------------------------------------------------------------------------
-- ENUMS
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'business_type' AND n.nspname = 'app') THEN
    CREATE TYPE app.business_type AS ENUM ('SALES', 'RENTAL', 'SALES_AND_RENTAL');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- PLATFORM ADMINS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_key VARCHAR(64) UNIQUE NOT NULL DEFAULT ('adm_' || replace(gen_random_uuid()::text, '-', '')),
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255),
  password_hash TEXT NOT NULL,
  full_name VARCHAR(255),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_admins_email ON app.platform_admins (email);
CREATE INDEX IF NOT EXISTS idx_platform_admins_username ON app.platform_admins (username);
CREATE INDEX IF NOT EXISTS idx_platform_admins_auth_key ON app.platform_admins (auth_key);

-- ----------------------------------------------------------------------------
-- TENANTS (SHOPS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(100) UNIQUE NOT NULL,
  original_slug VARCHAR(100),
  name VARCHAR(255) NOT NULL,
  auth_key VARCHAR(64) UNIQUE NOT NULL DEFAULT ('tnt_' || replace(gen_random_uuid()::text, '-', '')),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  business_type app.business_type NOT NULL DEFAULT 'SALES_AND_RENTAL',
  max_products INTEGER DEFAULT NULL,
  max_bookings INTEGER DEFAULT NULL,
  max_sales INTEGER DEFAULT NULL,
  created_by VARCHAR(255),
  created_by_admin_id UUID REFERENCES app.platform_admins(id) ON DELETE SET NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON app.tenants (status);
CREATE INDEX IF NOT EXISTS idx_tenants_auth_key ON app.tenants (auth_key);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON app.tenants (slug);
CREATE INDEX IF NOT EXISTS idx_tenants_original_slug ON app.tenants (original_slug);

-- ----------------------------------------------------------------------------
-- BRANDS & CATEGORIES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  name VARCHAR(20) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT brands_tenant_id_name_key UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_brands_tenant_id ON app.brands (tenant_id);

CREATE TABLE IF NOT EXISTS app.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  name VARCHAR(20) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT categories_tenant_id_name_key UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_categories_tenant_id ON app.categories (tenant_id);

-- ----------------------------------------------------------------------------
-- PRODUCTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  product_name VARCHAR(60) NOT NULL,
  product_code VARCHAR(20) NOT NULL,
  size VARCHAR(20) NOT NULL DEFAULT 'FREE',
  image TEXT,
  image2 TEXT,
  category VARCHAR(20),
  brand VARCHAR(20),
  gender VARCHAR(20),
  color VARCHAR(20),
  purchase_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  daily_rent DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  sale_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  total_quantity INT NOT NULL DEFAULT 0,
  damaged_quantity INT NOT NULL DEFAULT 0,
  sold_quantity INT NOT NULL DEFAULT 0,
  rented_quantity INT NOT NULL DEFAULT 0,
  availability_type VARCHAR(20) NOT NULL DEFAULT 'rent',
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'Available',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT products_tenant_id_product_code_key UNIQUE (tenant_id, product_code),
  CONSTRAINT chk_products_qty_nonneg CHECK (total_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_products_tenant_id ON app.products (tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON app.products (status);
CREATE INDEX IF NOT EXISTS idx_products_category ON app.products (category);
CREATE INDEX IF NOT EXISTS idx_products_brand ON app.products (brand);
CREATE INDEX IF NOT EXISTS idx_products_availability_type ON app.products (availability_type);

-- ----------------------------------------------------------------------------
-- PRODUCT INVENTORY LOG
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.product_inventory_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES app.products(id) ON DELETE CASCADE,
  change_type VARCHAR(30) NOT NULL,
  quantity INT NOT NULL,
  previous_quantity INT NOT NULL,
  new_quantity INT NOT NULL,
  reason VARCHAR(255),
  reference_type VARCHAR(50),
  reference_id VARCHAR(100),
  created_by VARCHAR(255),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pil_tenant_product ON app.product_inventory_logs (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_pil_tenant_created ON app.product_inventory_logs (tenant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- BOOKINGS (RENTALS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  bill_no VARCHAR(20) NOT NULL,
  customer_name VARCHAR(60) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  extra_phone_number VARCHAR(20),
  village_address VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'booked',
  choyani VARCHAR(20) NOT NULL DEFAULT '-',
  mojdi VARCHAR(255) NOT NULL DEFAULT '-',
  pant VARCHAR(20) NOT NULL DEFAULT '-',
  sol VARCHAR(20) NOT NULL DEFAULT '-',
  pickup_date TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  return_date TIMESTAMP(6) NOT NULL,
  rental_days INT NOT NULL DEFAULT 1,
  discount_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
  tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  accessories_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  security_deposit DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  deposit_paid BOOLEAN NOT NULL DEFAULT false,
  rental_total DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  paid_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  due_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(400),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bookings_tenant_id_bill_no_key UNIQUE (tenant_id, bill_no),
  CONSTRAINT chk_bookings_dates CHECK (return_date >= pickup_date),
  CONSTRAINT chk_bookings_paid_nonneg CHECK (paid_amount >= 0),
  CONSTRAINT chk_bookings_due_nonneg CHECK (due_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_bookings_tenant_id ON app.bookings (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON app.bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup_date ON app.bookings (pickup_date);
CREATE INDEX IF NOT EXISTS idx_bookings_return_date ON app.bookings (return_date);
CREATE INDEX IF NOT EXISTS idx_bookings_phone_number ON app.bookings (phone_number);
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_return_date ON app.bookings (tenant_id, return_date);

-- ----------------------------------------------------------------------------
-- BOOKING ITEMS (LINE ITEMS & OVERBOOKING PROTECTION)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.booking_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES app.bookings(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES app.products(id) ON DELETE RESTRICT,
  quantity INT NOT NULL,
  rent_type VARCHAR(20) NOT NULL DEFAULT 'daily',
  unit_rent DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  rental_days INT NOT NULL DEFAULT 1,
  total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  block_start DATE NOT NULL,
  block_end DATE NOT NULL,
  accessories JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_bi_qty_positive CHECK (quantity > 0),
  CONSTRAINT chk_bi_block_dates CHECK (block_end >= block_start)
);

CREATE INDEX IF NOT EXISTS idx_bi_tenant_booking ON app.booking_items (tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS idx_bi_tenant_product ON app.booking_items (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_bi_status ON app.booking_items (status);
CREATE INDEX IF NOT EXISTS idx_bi_availability ON app.booking_items (tenant_id, product_id, is_active, block_start, block_end);

-- ----------------------------------------------------------------------------
-- BOOKING RETURNS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.booking_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  booking_item_id UUID NOT NULL REFERENCES app.booking_items(id) ON DELETE CASCADE,
  returned_quantity INT NOT NULL,
  returned_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) NOT NULL,
  late_days INT NOT NULL DEFAULT 0,
  late_penalty DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  damage_quantity INT NOT NULL DEFAULT 0,
  damage_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  other_penalty DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  total_penalty DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(400),
  created_by VARCHAR(255),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_br_tenant_item ON app.booking_returns (tenant_id, booking_item_id);
CREATE INDEX IF NOT EXISTS idx_br_tenant_returned_at ON app.booking_returns (tenant_id, returned_at);

-- ----------------------------------------------------------------------------
-- SALES (POS RETAIL)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  bill_no VARCHAR(20) NOT NULL,
  customer_name VARCHAR(60) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  village_address VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'completed',
  discount_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
  tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  sale_total DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  paid_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  notes VARCHAR(400),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sales_tenant_id_bill_no_key UNIQUE (tenant_id, bill_no)
);

CREATE INDEX IF NOT EXISTS idx_sales_tenant_id ON app.sales (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON app.sales (status);
CREATE INDEX IF NOT EXISTS idx_sales_phone_number ON app.sales (phone_number);

-- ----------------------------------------------------------------------------
-- SALE ITEMS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES app.sales(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES app.products(id) ON DELETE RESTRICT,
  quantity INT NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  purchase_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  discount_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_si_tenant_sale ON app.sale_items (tenant_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_si_tenant_product ON app.sale_items (tenant_id, product_id);

-- ----------------------------------------------------------------------------
-- PAYMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES app.bookings(id) ON DELETE CASCADE,
  sale_id UUID REFERENCES app.sales(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  payment_method VARCHAR(30) NOT NULL DEFAULT 'CASH',
  payment_type VARCHAR(30) NOT NULL DEFAULT 'FINAL',
  allocation VARCHAR(30) NOT NULL DEFAULT 'RENTAL',
  direction VARCHAR(20) NOT NULL DEFAULT 'INFLOW',
  reference VARCHAR(100),
  notes VARCHAR(400),
  idempotency_key VARCHAR(100),
  paid_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(255),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT idx_payments_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant_booking ON app.payments (tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_sale ON app.payments (tenant_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_paid_at ON app.payments (tenant_id, paid_at);

-- ----------------------------------------------------------------------------
-- SETTINGS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID UNIQUE NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  company_name VARCHAR(100) NOT NULL DEFAULT '',
  page_title VARCHAR(255) NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  favicon_url TEXT NOT NULL DEFAULT '',
  phone_number VARCHAR(20) NOT NULL DEFAULT '',
  address VARCHAR(200) NOT NULL DEFAULT '',
  gst_number VARCHAR(50) NOT NULL DEFAULT '',
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
  upi_id TEXT NOT NULL DEFAULT '',
  whatsapp_url VARCHAR(150) NOT NULL DEFAULT '',
  instagram_link VARCHAR(150) NOT NULL DEFAULT '',
  facebook_url VARCHAR(150) NOT NULL DEFAULT '',
  terms_and_conditions VARCHAR(400) NOT NULL DEFAULT '',
  bill_show_logo BOOLEAN NOT NULL DEFAULT true,
  bill_show_gst BOOLEAN NOT NULL DEFAULT true,
  bill_show_upi BOOLEAN NOT NULL DEFAULT true,
  bill_show_signature BOOLEAN NOT NULL DEFAULT true,
  bill_show_subtotal BOOLEAN NOT NULL DEFAULT true,
  bill_show_accessories BOOLEAN NOT NULL DEFAULT true,
  bill_show_discount BOOLEAN NOT NULL DEFAULT true,
  bill_show_tax BOOLEAN NOT NULL DEFAULT true,
  bill_show_security_deposit BOOLEAN NOT NULL DEFAULT true,
  bill_rental_title VARCHAR(100) NOT NULL DEFAULT 'Rental Bill',
  bill_sale_title VARCHAR(100) NOT NULL DEFAULT 'Sale Bill',
  bill_header_note TEXT NOT NULL DEFAULT '',
  bill_footer_note TEXT NOT NULL DEFAULT '',
  rental_day_calculation_mode VARCHAR(30) NOT NULL DEFAULT 'DIFF_2_DAYS',
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- USERS (TENANT SHOP OWNERS & STAFF)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  auth_key VARCHAR(64) UNIQUE NOT NULL DEFAULT ('usr_' || replace(gen_random_uuid()::text, '-', '')),
  email VARCHAR(255) NOT NULL,
  original_email VARCHAR(255),
  password_hash TEXT NOT NULL,
  full_name VARCHAR(255),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_tenant_id_email_key UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON app.users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON app.users (email);
CREATE INDEX IF NOT EXISTS idx_users_auth_key ON app.users (auth_key);

-- ----------------------------------------------------------------------------
-- ACTIVITY LOGS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES app.users(id) ON DELETE SET NULL,
  user_email VARCHAR(255),
  user_name VARCHAR(255),
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100),
  summary TEXT NOT NULL,
  changes JSONB,
  metadata JSONB,
  ip_address VARCHAR(50),
  user_agent VARCHAR(1000),
  browser_name VARCHAR(50),
  browser_version VARCHAR(50),
  os_name VARCHAR(50),
  os_version VARCHAR(50),
  device_type VARCHAR(50),
  device_name VARCHAR(100),
  request_id VARCHAR(100),
  request_method VARCHAR(20),
  request_path VARCHAR(500),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_created ON app.activity_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_entity ON app.activity_logs (tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_user_created ON app.activity_logs (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_action ON app.activity_logs (tenant_id, action);
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_ip ON app.activity_logs (tenant_id, ip_address);
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_request_id ON app.activity_logs (tenant_id, request_id);

-- ----------------------------------------------------------------------------
-- PASSWORD RESET OTPS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.password_reset_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES app.tenants(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  otp_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP(6) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  resend_after TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TIMESTAMP(6),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_otp_email ON app.password_reset_otps (email);
CREATE INDEX IF NOT EXISTS idx_password_reset_otp_user ON app.password_reset_otps (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_otp_expires ON app.password_reset_otps (expires_at);

-- ----------------------------------------------------------------------------
-- EMAIL LOGS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.email_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES app.tenants(id) ON DELETE SET NULL,
  provider VARCHAR(50) NOT NULL,
  from_address VARCHAR(255) NOT NULL,
  to_address VARCHAR(255) NOT NULL,
  cc VARCHAR(255),
  bcc VARCHAR(255),
  subject VARCHAR(500) NOT NULL,
  template_name VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  message_id VARCHAR(255),
  error_message TEXT,
  metadata JSONB,
  sent_at TIMESTAMP(6),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_logs_tenant_created ON app.email_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_to_address ON app.email_logs (to_address);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON app.email_logs (status);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON app.email_logs (created_at DESC);

-- ----------------------------------------------------------------------------
-- REVOKED TOKENS (LOGOUT & SESSION INVALIDATION)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.revoked_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jti VARCHAR(64) UNIQUE NOT NULL,
  user_id UUID NOT NULL,
  expires_at TIMESTAMP(6) NOT NULL,
  revoked_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti ON app.revoked_tokens (jti);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON app.revoked_tokens (expires_at);

-- ----------------------------------------------------------------------------
-- PASSWORD CHANGE LOGS (DAILY LIMIT AUDIT)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.password_change_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES app.tenants(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL,
  ip_address VARCHAR(50),
  user_agent VARCHAR(500),
  changed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_change_logs_user_changed ON app.password_change_logs (user_id, changed_at DESC);

-- ----------------------------------------------------------------------------
-- BILL SHARE TOKENS (PUBLIC PDF DOWNLOAD LINKS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.bill_share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(64) UNIQUE NOT NULL,
  type VARCHAR(20) NOT NULL,
  record_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  expires_at TIMESTAMP(6) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bill_share_tokens_token ON app.bill_share_tokens (token);
CREATE INDEX IF NOT EXISTS idx_bill_share_tokens_expires ON app.bill_share_tokens (expires_at);
