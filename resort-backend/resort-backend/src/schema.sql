-- ============================================================
-- Hotel Management System — Database Schema (PostgreSQL / Supabase)
-- Run this once in the Supabase SQL editor to create every table.
-- ============================================================

-- Every admin = one tenant. Everything else hangs off admin_id.
CREATE TABLE admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- bcrypt hash, server-generated
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  staff_id      TEXT NOT NULL,          -- the human-chosen login id, e.g. "staff001"
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  department    TEXT NOT NULL CHECK (department IN ('room','banquet','restaurant')),
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_id, staff_id),          -- staff_id only needs to be unique per tenant
  UNIQUE (admin_id, department)         -- mirrors existing rule: one staff account per department
);

CREATE TABLE hotel_settings (
  admin_id      UUID PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
  hotel_name    TEXT,
  address       TEXT,
  phone         TEXT,
  logo_url      TEXT,
  invoice_seq   INTEGER NOT NULL DEFAULT 0,   -- replaces invoice-seq:<adminId>
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE restaurant_settings (
  admin_id      UUID PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
  table_count   INTEGER NOT NULL DEFAULT 4,
  extra JSONB   NOT NULL DEFAULT '{}'::jsonb,  -- room for any extra restaurant-info fields without a migration
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE menu_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  category      TEXT,
  price         NUMERIC(10,2) NOT NULL,
  is_veg        BOOLEAN DEFAULT true,
  deleted_at    TIMESTAMPTZ,             -- soft delete, replaces deleted-menu-items list
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_menu_items_admin ON menu_items(admin_id) WHERE deleted_at IS NULL;

CREATE TABLE promo_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  discount_value NUMERIC(10,2) NOT NULL,
  expiry_date    DATE,
  max_uses       INTEGER,
  used_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_id, code)
);

CREATE TABLE restaurant_tables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  table_no        INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','active')),
  customer_name   TEXT DEFAULT '',
  customer_phone  TEXT DEFAULT '',
  items           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- order line items, live/in-progress bill
  applied_promo   TEXT,
  payment_method  TEXT DEFAULT 'Cash',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_id, table_no)
);

CREATE TABLE room_floors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  floor      TEXT NOT NULL,
  room_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE room_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  name       TEXT NOT NULL
);

CREATE TABLE rooms (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  room_no           TEXT NOT NULL,
  floor             TEXT,
  category_id       UUID REFERENCES room_categories(id) ON DELETE SET NULL,
  bed_type          TEXT,
  ac                BOOLEAN DEFAULT false,
  max_adults        INTEGER DEFAULT 2,
  max_children      INTEGER DEFAULT 0,
  price             NUMERIC(10,2) NOT NULL DEFAULT 0,
  amenities         JSONB NOT NULL DEFAULT '[]'::jsonb,
  extra_bed_allowed BOOLEAN DEFAULT false,
  extra_bed_price   NUMERIC(10,2) DEFAULT 0,
  out_of_order      BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_id, room_no)
);

-- A room's "current status" (available/occupied) is DERIVED from whether it
-- has a row here with status='active' — not stored redundantly on rooms.
CREATE TABLE room_bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id            UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  room_id             UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  guest_name          TEXT NOT NULL,
  guest_phone         TEXT,
  check_in            TIMESTAMPTZ NOT NULL,
  check_out           TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  invoice_id          UUID,               -- FK added after invoices table exists
  created_by_staff_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_room_bookings_room ON room_bookings(room_id);
CREATE INDEX idx_room_bookings_admin ON room_bookings(admin_id);

CREATE TABLE banquet_halls (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  capacity     INTEGER,
  facilities   JSONB NOT NULL DEFAULT '[]'::jsonb,
  out_of_order BOOLEAN DEFAULT false,
  pricing      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {hour:{enabled,price}, day:{...}, week:{...}}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE banquet_bookings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id               UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  booking_code           TEXT,
  hall_id                UUID NOT NULL REFERENCES banquet_halls(id) ON DELETE CASCADE,
  customer_name          TEXT NOT NULL,
  customer_phone         TEXT,
  guest_count             INTEGER,
  event_type             TEXT,                 -- Wedding, Birthday, Conference, etc. — descriptive only
  food_package            TEXT,                 -- label of the chosen catering tier, e.g. "Veg Premium"
  decoration_package      TEXT,                 -- label of the chosen decor tier, e.g. "Luxury"
  pricing_basis           TEXT CHECK (pricing_basis IN ('hour','day','week')),
  unit_price               NUMERIC(10,2),
  duration_count           NUMERIC(10,2),
  start_at                TIMESTAMPTZ NOT NULL,
  end_at                  TIMESTAMPTZ NOT NULL,
  total_amount             NUMERIC(10,2),
  advance_amount           NUMERIC(10,2) NOT NULL DEFAULT 0,
  advance_payment_method   TEXT,
  balance_paid             BOOLEAN NOT NULL DEFAULT false,
  balance_paid_at          TIMESTAMPTZ,
  status                  TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled')),
  invoice_id               UUID,
  created_by_staff_id      TEXT,
  created_by_name          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_banquet_bookings_hall ON banquet_bookings(hall_id);
CREATE INDEX idx_banquet_bookings_admin ON banquet_bookings(admin_id);

-- One row per invoice, whatever department it came from.
CREATE TABLE invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id            UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  invoice_no          TEXT NOT NULL,
  department          TEXT NOT NULL CHECK (department IN ('room','banquet','restaurant')),
  customer_name       TEXT,
  customer_phone      TEXT,
  table_no            INTEGER,           -- restaurant only
  room_booking_id     UUID REFERENCES room_bookings(id) ON DELETE SET NULL,
  banquet_booking_id  UUID REFERENCES banquet_bookings(id) ON DELETE SET NULL,
  subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  promo_code          TEXT,
  total_amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method      TEXT,
  created_by_staff_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_id, invoice_no)
);
CREATE INDEX idx_invoices_admin_dept ON invoices(admin_id, department);

-- Restaurant invoices only: individual line items.
CREATE TABLE invoice_line_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  quantity    NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL,
  line_total  NUMERIC(10,2) NOT NULL
);

ALTER TABLE room_bookings    ADD CONSTRAINT fk_room_booking_invoice    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE banquet_bookings ADD CONSTRAINT fk_banquet_booking_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

-- One subscription row per admin/tenant. Created automatically at signup
-- (see routes/auth.js) with status defaulting to 'inactive', so a brand new
-- admin is routed to the subscription paywall until they pay or a promo
-- code activates it. amount defaults to the ₹12,000/year plan price shown
-- on that paywall screen — change this default if the real price differs.
CREATE TABLE subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id           UUID NOT NULL UNIQUE REFERENCES admins(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','pending','active','expired')),
  plan_name          TEXT NOT NULL DEFAULT 'Standard Plan',
  amount             NUMERIC(10,2) NOT NULL DEFAULT 12000.00,
  start_date         TIMESTAMPTZ,
  expiry_date        TIMESTAMPTZ,
  payment_provider   TEXT,
  payment_id         TEXT,
  razorpay_order_id  TEXT,
  promo_code_used    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_admin ON subscriptions(admin_id);

-- Promo codes YOU (the platform operator) create to comp or discount a
-- subscription for someone — separate from the per-tenant restaurant
-- promo_codes table above. Not tied to any single admin/tenant.
CREATE TABLE subscription_promo_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL UNIQUE,
  discount_percent  NUMERIC(5,2) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
  active            BOOLEAN NOT NULL DEFAULT true,
  expires_at        TIMESTAMPTZ,
  max_uses          INTEGER,
  used_count        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);