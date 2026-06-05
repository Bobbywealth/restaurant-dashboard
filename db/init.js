// db/init.js — run once to create tables
// Usage: DATABASE_URL=postgres://... node db/init.js
// Or: npm run init-db (uses .env)
require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set. Set it in your environment or .env file.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS menu_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INT DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  category_id INT REFERENCES menu_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost NUMERIC(10,2) DEFAULT 0,
  sku TEXT,
  image_url TEXT,
  available BOOLEAN DEFAULT true,
  featured BOOLEAN DEFAULT false,
  allergens TEXT,
  prep_time_minutes INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  hourly_rate NUMERIC(10,2) DEFAULT 0,
  hire_date DATE,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  staff_id INT REFERENCES staff(id) ON DELETE CASCADE,
  shift_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  role TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  external_id TEXT,
  source TEXT NOT NULL,
  status TEXT,
  total NUMERIC(10,2) DEFAULT 0,
  subtotal NUMERIC(10,2) DEFAULT 0,
  tax NUMERIC(10,2) DEFAULT 0,
  tip NUMERIC(10,2) DEFAULT 0,
  items_count INT DEFAULT 0,
  customer_name TEXT,
  customer_phone TEXT,
  placed_at TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  total_orders INT DEFAULT 0,
  total_spent NUMERIC(10,2) DEFAULT 0,
  last_visit DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INT REFERENCES menu_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  quantity INT DEFAULT 1,
  price NUMERIC(10,2) DEFAULT 0,
  modifiers JSONB
);

CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);
CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders(placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_shifts_staff ON shifts(staff_id);
`;

const SEED = [
  // Default settings
  `INSERT INTO settings (key, value) VALUES
    ('restaurant_name', '"Sashey'\''s Kitchen"'::jsonb),
    ('restaurant_phone', '"(908) 686-8178"'::jsonb),
    ('restaurant_address', '{}'::jsonb),
    ('hours', '{"mon":[{"open":"11:00","close":"22:00"}],"tue":[{"open":"11:00","close":"22:00"}],"wed":[{"open":"11:00","close":"22:00"}],"thu":[{"open":"11:00","close":"22:00"}],"fri":[{"open":"11:00","close":"23:00"}],"sat":[{"open":"12:00","close":"23:00"}],"sun":[{"open":"12:00","close":"21:00"}]}'::jsonb),
    ('tax_rate', '0.06625'::jsonb),
    ('currency', '"USD"'::jsonb),
    ('doordash_commission', '0.30'::jsonb),
    ('ubereats_commission', '0.30'::jsonb),
    ('grubhub_commission', '0.275'::jsonb)
  ON CONFLICT (key) DO NOTHING;`,
  // Default menu categories
  `INSERT INTO menu_categories (name, sort_order) VALUES
    ('Appetizers', 1),
    ('Mains', 2),
    ('Sides', 3),
    ('Drinks', 4),
    ('Desserts', 5)
  ON CONFLICT (name) DO NOTHING;`,
  // Sample staff
  `INSERT INTO staff (name, role, hourly_rate, active) VALUES
    ('Shamfa Simmonds', 'Owner', 0, true),
    ('Marcus Johnson', 'Head Chef', 28.00, true),
    ('Keisha Williams', 'Line Cook', 18.00, true),
    ('David Brown', 'Cashier', 16.00, true),
    ('Aisha Thompson', 'Server', 15.00, true)
  ON CONFLICT DO NOTHING;`,
];

(async () => {
  const client = await pool.connect();
  try {
    console.log('Initializing schema...');
    await client.query(SCHEMA);
    console.log('Schema created.');

    console.log('Seeding defaults...');
    for (const stmt of SEED) {
      await client.query(stmt);
    }
    console.log('Seed data inserted.');

    // Show counts
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM menu_categories) AS categories,
        (SELECT COUNT(*) FROM menu_items) AS items,
        (SELECT COUNT(*) FROM staff) AS staff,
        (SELECT COUNT(*) FROM settings) AS settings
    `);
    console.log('Final counts:', counts.rows[0]);
    console.log('\n✅ Database initialized successfully.');
  } catch (err) {
    console.error('Init failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
