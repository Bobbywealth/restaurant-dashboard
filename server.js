require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Database ───────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  console.log('Database pool initialized');
} else {
  console.warn('DATABASE_URL not set — running without persistence');
}

async function dbQuery(text, params) {
  if (!pool) throw new Error('Database not configured');
  const r = await pool.query(text, params);
  return r;
}

// ─── Toast POS Config ─────────────────────────────────────────────────────
const TOAST_API_BASE = 'https://ws-api.toasttab.com';
const TOAST_AUTH_URL = `${TOAST_API_BASE}/authentication/v1/authentication/login`;
const TOAST_ORDERS_URL = `${TOAST_API_BASE}/orders/v1/orders`;
const RESTAURANT_GUID = '8d0d8d7b-1fcc-43fd-8be5-1413efbaaef7';

let toastToken = null;
let tokenExpiry = 0;

function formatDate(date) { return date.toISOString().split('T')[0].replace(/-/g, ''); }
function todayStr() { return formatDate(new Date()); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return formatDate(d); }

async function getToastToken() {
  if (toastToken && Date.now() < tokenExpiry) return toastToken;
  const credentials = {
    clientId: process.env.TOAST_CLIENT_ID || 'fWtDwDjMLuvklqFykpMuY9tbz19g1th9',
    clientSecret: process.env.TOAST_CLIENT_SECRET || '3_uTSyXKvPZwZUMYlCV-PJFd8Twka8QnlORetJI2kxLe1ki7aW5c9ot3ySMBykwp',
    userAccessType: 'TOAST_MACHINE'
  };
  const res = await fetch(TOAST_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials)
  });
  if (!res.ok) throw new Error(`Toast auth failed: ${res.status}`);
  const data = await res.json();
  toastToken = data.token.accessToken;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return toastToken;
}

async function getToastOrders(dateStr) {
  const token = await getToastToken();
  const url = `${TOAST_ORDERS_URL}?restaurantGuid=${RESTAURANT_GUID}&businessDate=${dateStr}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Toast-Restaurant-External-ID': RESTAURANT_GUID }
  });
  if (!res.ok) throw new Error(`Toast orders failed: ${res.status}`);
  return await res.json();
}

// Mock third-party data
function getPlatformOrders(source, dateStr) {
  const seed = dateStr.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = (n) => (seed * 9301 + 49297) % 233280 / 233280 * n;
  const configs = {
    doordash: { avgTicket: 28, ordersPerDay: 45 },
    ubereats: { avgTicket: 32, ordersPerDay: 38 },
    grubhub:  { avgTicket: 25, ordersPerDay: 22 }
  };
  const cfg = configs[source];
  if (!cfg) return { source, date: dateStr, orders: [], summary: { totalOrders: 0, totalRevenue: 0 } };
  const totalOrders = Math.floor(rand(cfg.ordersPerDay));
  const totalRevenue = parseFloat((totalOrders * cfg.avgTicket * (0.9 + rand(0.2))).toFixed(2));
  const avgOrderValue = totalOrders > 0 ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0;
  const statuses = ['COMPLETED','COMPLETED','COMPLETED','ACCEPTED','PREPARING'];
  const orders = [];
  for (let i = 0; i < totalOrders; i++) {
    const hour = 10 + Math.floor(rand(14));
    const minute = Math.floor(rand(60));
    orders.push({
      orderId: `${source.toUpperCase().slice(0,2)}-ORD-${dateStr}-${i + 100}`,
      placedAt: `${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}`,
      status: statuses[Math.floor(rand(statuses.length))],
      items: Math.floor(rand(5)) + 1,
      subtotal: parseFloat((rand(cfg.avgTicket * 0.8) + cfg.avgTicket * 0.2).toFixed(2)),
      total: parseFloat((rand(cfg.avgTicket) + cfg.avgTicket * 0.5).toFixed(2))
    });
  }
  return { source, date: dateStr, orders, summary: { totalOrders, totalRevenue, avgOrderValue } };
}

// ─── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', db: !!pool, timestamp: new Date().toISOString() }));

// POS
app.get('/api/pos/:range', async (req, res) => {
  const { range } = req.params;
  let dateStr;
  if (range === 'today') dateStr = todayStr();
  else if (range === 'yesterday') dateStr = yesterdayStr();
  else return res.status(400).json({ error: 'Use /api/pos/today or /api/pos/yesterday' });
  try {
    const data = await getToastOrders(dateStr);
    const orders = data.orders || [];
    const totalRevenue = orders.reduce((sum, o) => sum + (parseFloat(o.totalAmount) || 0), 0);
    const totalOrders = orders.length;
    res.json({
      source: 'toast_pos', date: dateStr, orders,
      summary: {
        totalOrders,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        avgOrderValue: totalOrders > 0 ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

['doordash', 'ubereats', 'grubhub'].forEach(platform => {
  app.get(`/api/${platform}/:range`, (req, res) => {
    const { range } = req.params;
    let dateStr;
    if (range === 'today') dateStr = todayStr();
    else if (range === 'yesterday') dateStr = yesterdayStr();
    else return res.status(400).json({ error: `Use /api/${platform}/today or /api/${platform}/yesterday` });
    res.json(getPlatformOrders(platform, dateStr));
  });
});

app.get('/api/stats/summary', async (req, res) => {
  const today = todayStr();
  let posSummary = { totalOrders: 0, totalRevenue: 0 };
  try {
    const data = await getToastOrders(today);
    const orders = data.orders || [];
    const totalRevenue = orders.reduce((sum, o) => sum + (parseFloat(o.totalAmount) || 0), 0);
    posSummary = { totalOrders: orders.length, totalRevenue: parseFloat(totalRevenue.toFixed(2)) };
  } catch (e) { /* POS may fail */ }
  const dd = getPlatformOrders('doordash', today).summary;
  const ue = getPlatformOrders('ubereats', today).summary;
  const gh = getPlatformOrders('grubhub', today).summary;
  const thirdPartyTotal = dd.totalRevenue + ue.totalRevenue + gh.totalRevenue;
  const thirdPartyOrders = dd.totalOrders + ue.totalOrders + gh.totalOrders;
  const combinedRevenue = posSummary.totalRevenue + thirdPartyTotal;
  const combinedOrders = posSummary.totalOrders + thirdPartyOrders;
  res.json({
    date: today, pos: posSummary, doordash: dd, ubereats: ue, grubhub: gh,
    thirdParty: { totalOrders: thirdPartyOrders, totalRevenue: parseFloat(thirdPartyTotal.toFixed(2)) },
    combined: {
      totalOrders: combinedOrders,
      totalRevenue: parseFloat(combinedRevenue.toFixed(2)),
      avgOrderValue: combinedOrders > 0 ? parseFloat((combinedRevenue / combinedOrders).toFixed(2)) : 0
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MENU API
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/menu/categories', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const r = await dbQuery('SELECT * FROM menu_categories ORDER BY sort_order, name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/menu/categories', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { name, sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await dbQuery(
      'INSERT INTO menu_categories (name, sort_order) VALUES ($1, $2) RETURNING *',
      [name, sort_order]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/menu/categories/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.params;
  const { name, sort_order, active } = req.body;
  try {
    const r = await dbQuery(
      'UPDATE menu_categories SET name = COALESCE($1, name), sort_order = COALESCE($2, sort_order), active = COALESCE($3, active) WHERE id = $4 RETURNING *',
      [name, sort_order, active, id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/menu/categories/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.params;
  try {
    await dbQuery('DELETE FROM menu_categories WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/menu/items', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { category_id, available } = req.query;
    let q = 'SELECT mi.*, mc.name AS category_name FROM menu_items mi LEFT JOIN menu_categories mc ON mi.category_id = mc.id';
    const params = [];
    const conds = [];
    if (category_id) { params.push(category_id); conds.push(`mi.category_id = $${params.length}`); }
    if (available === 'true') { conds.push('mi.available = true'); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY mc.sort_order, mi.name';
    const r = await dbQuery(q, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/menu/items', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { name, description, price, cost, category_id, sku, image_url, available, featured, allergens, prep_time_minutes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await dbQuery(
      `INSERT INTO menu_items (name, description, price, cost, category_id, sku, image_url, available, featured, allergens, prep_time_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [name, description, price || 0, cost || 0, category_id, sku, image_url, available !== false, featured || false, allergens, prep_time_minutes]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/menu/items/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.params;
  const { name, description, price, cost, category_id, sku, image_url, available, featured, allergens, prep_time_minutes } = req.body;
  try {
    const r = await dbQuery(
      `UPDATE menu_items SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        price = COALESCE($3, price),
        cost = COALESCE($4, cost),
        category_id = COALESCE($5, category_id),
        sku = COALESCE($6, sku),
        image_url = COALESCE($7, image_url),
        available = COALESCE($8, available),
        featured = COALESCE($9, featured),
        allergens = COALESCE($10, allergens),
        prep_time_minutes = COALESCE($11, prep_time_minutes),
        updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [name, description, price, cost, category_id, sku, image_url, available, featured, allergens, prep_time_minutes, id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/menu/items/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.params;
  try {
    await dbQuery('DELETE FROM menu_items WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// STAFF API
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/staff', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const r = await dbQuery('SELECT * FROM staff ORDER BY active DESC, name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/staff', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { name, role, email, phone, hourly_rate, hire_date, notes, active } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role required' });
  try {
    const r = await dbQuery(
      `INSERT INTO staff (name, role, email, phone, hourly_rate, hire_date, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, role, email, phone, hourly_rate || 0, hire_date, notes, active !== false]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/staff/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.params;
  const { name, role, email, phone, hourly_rate, hire_date, notes, active } = req.body;
  try {
    const r = await dbQuery(
      `UPDATE staff SET
        name = COALESCE($1, name),
        role = COALESCE($2, role),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        hourly_rate = COALESCE($5, hourly_rate),
        hire_date = COALESCE($6, hire_date),
        notes = COALESCE($7, notes),
        active = COALESCE($8, active)
       WHERE id = $9 RETURNING *`,
      [name, role, email, phone, hourly_rate, hire_date, notes, active, id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/staff/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.params;
  try {
    await dbQuery('DELETE FROM staff WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shifts
app.get('/api/shifts', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { start, end } = req.query;
    let q = `SELECT s.*, st.name AS staff_name, st.role AS staff_role, st.hourly_rate
             FROM shifts s LEFT JOIN staff st ON s.staff_id = st.id`;
    const params = [];
    const conds = [];
    if (start) { params.push(start); conds.push(`s.shift_date >= $${params.length}`); }
    if (end)   { params.push(end);   conds.push(`s.shift_date <= $${params.length}`); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY s.shift_date, s.start_time';
    const r = await dbQuery(q, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shifts', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { staff_id, shift_date, start_time, end_time, role, notes } = req.body;
  if (!staff_id || !shift_date || !start_time || !end_time) return res.status(400).json({ error: 'staff_id, shift_date, start_time, end_time required' });
  try {
    const r = await dbQuery(
      `INSERT INTO shifts (staff_id, shift_date, start_time, end_time, role, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [staff_id, shift_date, start_time, end_time, role, notes]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/shifts/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { id } = req.params;
  try {
    await dbQuery('DELETE FROM shifts WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Labor cost summary
app.get('/api/staff/labor', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { start, end } = req.query;
    const r = await dbQuery(`
      SELECT
        st.id, st.name, st.role, st.hourly_rate,
        COUNT(s.id) AS shift_count,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 3600
        ), 0) AS total_hours,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 3600 * st.hourly_rate
        ), 0) AS total_cost
      FROM staff st
      LEFT JOIN shifts s ON s.staff_id = st.id
        AND ($1::date IS NULL OR s.shift_date >= $1)
        AND ($2::date IS NULL OR s.shift_date <= $2)
      WHERE st.active = true
      GROUP BY st.id, st.name, st.role, st.hourly_rate
      ORDER BY total_cost DESC NULLS LAST
    `, [start || null, end || null]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS API
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/settings', async (req, res) => {
  if (!pool) return res.json({});
  try {
    const r = await dbQuery('SELECT * FROM settings');
    const out = {};
    r.rows.forEach(row => { out[row.key] = row.value; });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/:key', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { key } = req.params;
  const { value } = req.body;
  try {
    const r = await dbQuery(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW() RETURNING *`,
      [key, JSON.stringify(value)]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS / ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/reports/sales', async (req, res) => {
  // Mock daily sales for the last N days (would normally come from order history)
  const { days = 7 } = req.query;
  const numDays = parseInt(days);
  const out = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = formatDate(d);
    const seed = dateStr.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const rand = (n) => (seed * 9301 + 49297) % 233280 / 233280 * n;
    const pos = Math.floor(rand(28)) * 38;
    const dd = Math.floor(rand(45)) * 28;
    const ue = Math.floor(rand(38)) * 32;
    const gh = Math.floor(rand(22)) * 25;
    const total = pos + dd + ue + gh;
    out.push({
      date: d.toISOString().split('T')[0],
      pos, doordash: dd, ubereats: ue, grubhub: gh,
      total,
      orders: Math.floor(rand(28)) + Math.floor(rand(45)) + Math.floor(rand(38)) + Math.floor(rand(22))
    });
  }
  res.json(out);
});

app.get('/api/reports/top-items', async (req, res) => {
  // If menu items exist, use them; else generate mock
  if (!pool) return res.json([]);
  try {
    const r = await dbQuery(`
      SELECT id, name, price, cost,
        CASE WHEN cost > 0 THEN ROUND((price - cost) / price * 100, 1) ELSE 70.0 END AS margin_pct
      FROM menu_items
      WHERE available = true
      ORDER BY featured DESC, name
      LIMIT 10
    `);
    if (r.rows.length === 0) {
      // Mock data when no menu exists
      return res.json([
        { name: 'Jerk Chicken Platter', count: 47, revenue: 612.53, margin_pct: 68 },
        { name: 'Oxtail Stew', count: 38, revenue: 798.42, margin_pct: 72 },
        { name: 'Curry Goat', count: 31, revenue: 651.31, margin_pct: 65 },
        { name: 'Plantains', count: 89, revenue: 445.11, margin_pct: 80 },
        { name: 'Rice & Peas', count: 76, revenue: 304.00, margin_pct: 78 },
        { name: 'Ackee & Saltfish', count: 22, revenue: 286.00, margin_pct: 64 },
        { name: 'Beef Patty', count: 64, revenue: 192.00, margin_pct: 75 },
        { name: 'Sorrel Drink', count: 53, revenue: 159.00, margin_pct: 85 }
      ]);
    }
    // For each menu item, generate mock sales count
    return res.json(r.rows.map(it => ({
      id: it.id,
      name: it.name,
      price: parseFloat(it.price),
      cost: parseFloat(it.cost || 0),
      margin_pct: parseFloat(it.margin_pct),
      count: Math.floor(Math.random() * 50) + 5,
      revenue: parseFloat(it.price) * (Math.floor(Math.random() * 50) + 5)
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/profit', async (req, res) => {
  // Revenue minus commission, minus labor
  try {
    const salesRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/reports/sales?days=30`);
    const sales = await salesRes.json();
    const totalRevenue = sales.reduce((s, d) => s + d.total, 0);
    const totalOrders = sales.reduce((s, d) => s + d.orders, 0);

    // Estimated costs
    const thirdPartyShare = sales.reduce((s, d) => s + d.doordash + d.ubereats + d.grubhub, 0) / totalRevenue;
    const commission = totalRevenue * thirdPartyShare * 0.30; // ~30% commission
    const foodCost = totalRevenue * 0.30; // ~30% food cost industry standard
    const laborEst = totalRevenue * 0.25; // ~25% labor cost
    const netProfit = totalRevenue - commission - foodCost - laborEst;

    res.json({
      period: 'last_30_days',
      revenue: parseFloat(totalRevenue.toFixed(2)),
      orders: totalOrders,
      costs: {
        third_party_commission: parseFloat(commission.toFixed(2)),
        food_cost: parseFloat(foodCost.toFixed(2)),
        labor: parseFloat(laborEst.toFixed(2))
      },
      net_profit: parseFloat(netProfit.toFixed(2)),
      margin_pct: parseFloat(((netProfit / totalRevenue) * 100).toFixed(1))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS / ALERTS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', async (req, res) => {
  if (!pool) return res.json({ items: [], count: 0 });
  try {
    const items = [];
    // Low stock alerts
    const inv = await dbQuery(`SELECT * FROM settings WHERE key = 'inventory_alerts'`);
    if (inv.rows[0]?.value?.items) {
      inv.rows[0].value.items.filter(i => i.qty <= i.minQty).forEach(i => {
        items.push({
          type: 'low_stock',
          severity: 'warning',
          icon: '📦',
          title: `Low stock: ${i.name}`,
          detail: `${i.qty} ${i.unit} remaining (min: ${i.minQty})`,
          timestamp: new Date().toISOString()
        });
      });
    }
    res.json({ items: items.slice(0, 20), count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Global search
app.get('/api/search', async (req, res) => {
  if (!pool) return res.json({ menu: [], staff: [], customers: [] });
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ menu: [], staff: [], customers: [] });
  try {
    const term = `%${q}%`;
    const [menu, staff, customers] = await Promise.all([
      dbQuery('SELECT id, name, price FROM menu_items WHERE name ILIKE $1 LIMIT 10', [term]),
      dbQuery('SELECT id, name, role FROM staff WHERE name ILIKE $1 OR role ILIKE $1 LIMIT 10', [term]),
      dbQuery('SELECT id, name, phone FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 LIMIT 10', [term])
    ]);
    res.json({ menu: menu.rows, staff: staff.rows, customers: customers.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'frontend')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaurant dashboard running on ${PORT}`));
