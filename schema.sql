CREATE TABLE IF NOT EXISTS products (
  id_menu TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shop_orders (
  ref TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  loyalty TEXT NOT NULL DEFAULT '',
  items JSONB NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLACED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_orders_date ON shop_orders(created_at DESC);

-- Run these statements even when shop_orders already exists.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS loyalty_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS shop_orders_loyalty_key_unique
  ON shop_orders (loyalty_key) WHERE loyalty_key IS NOT NULL;
