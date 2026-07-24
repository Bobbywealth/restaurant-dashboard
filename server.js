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
const TOAST_PAGE_SIZE = 100;
const RESTAURANT_GUID = '8d0d8d7b-1fcc-43fd-8be5-1413efbaaef7';
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || 'Top Taste Jamaican Restaurant';

let toastToken = null;
let tokenExpiry = 0;

// ─── Toast helpers ────────────────────────────────────────────────────────
// Net revenue per order: gross minus tip, tax, and any voided amount.
// Toast's totalAmount is GROSS (includes tax + tip). We want net food+bev revenue.
function computeNetRevenue(order) {
  const total  = parseFloat(order.totalAmount)  || 0;
  const tip    = parseFloat(order.tipAmount)    || parseFloat(order.tip) || 0;
  const tax    = parseFloat(order.taxAmount)    || 0;
  const voided = parseFloat(order.voidAmount)   || 0;
  const net    = total - tip - tax - voided;
  return Math.max(0, parseFloat(net.toFixed(2)));
}

// Order is counted in revenue if it's not voided or deleted.
function isRealOrder(order) {
  const status = (order.status || '').toUpperCase();
  return status !== 'VOIDED' && status !== 'DELETED';
}

async function toastFetch(url) {
  const token = await getToastToken();
  let res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': RESTAURANT_GUID
    }
  });
  if (res.status === 401) {
    // Toast tokens expire ~1h; force re-auth and retry once
    toastToken = null;
    const fresh = await getToastToken();
    res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${fresh}`,
        'Toast-Restaurant-External-ID': RESTAURANT_GUID
      }
    });
  }
  if (!res.ok) throw new Error(`Toast request failed: ${res.status}`);
  return res.json();
}

// Get all orders for a business date, paginating through every page.
async function getToastOrdersAllPages(dateStr) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${TOAST_ORDERS_URL}?restaurantGuid=${RESTAURANT_GUID}&businessDate=${dateStr}&page=${page}&pageSize=${TOAST_PAGE_SIZE}`;
    const data = await toastFetch(url);
    const batch = data.orders || [];
    all.push(...batch);
    if (batch.length < TOAST_PAGE_SIZE) break;
  }
  // Exclude voided / deleted orders so totals reflect real revenue.
  return all.filter(isRealOrder);
}

// Returns net revenue + order count for a single business date.
async function getToastDaySummary(dateStr) {
  try {
    const orders = await getToastOrdersAllPages(dateStr);
    const totalRevenue = orders.reduce((s, o) => s + computeNetRevenue(o), 0);
    return {
      orders: orders.length,
      revenue: parseFloat(totalRevenue.toFixed(2))
    };
  } catch (e) {
    return { orders: 0, revenue: 0, error: e.message };
  }
}

function formatDate(date) {
  // Use New York local time so 'today' matches the restaurant's business day
  const opts = { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}${m}${d}`;
}
function todayStr() { return formatDate(new Date()); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return formatDate(d); }

async function getToastToken() {
  if (toastToken && Date.now() < tokenExpiry) return toastToken;
  // Require env vars — never fall back to hardcoded creds.
  const clientId = process.env.TOAST_CLIENT_ID;
  const clientSecret = process.env.TOAST_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('TOAST_CLIENT_ID / TOAST_CLIENT_SECRET not configured');
  }
  const credentials = {
    clientId,
    clientSecret,
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
  // Toast access tokens expire at ~1 hour; refresh after 55 minutes to stay safe.
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return toastToken;
}

async function getToastOrders(dateStr) {
  return await getToastOrdersAllPages(dateStr);
}

// Third-party delivery platforms (DoorDash, Uber Eats, Grubhub).
// These integrations are NOT yet wired up — return an explicit "not connected"
// stub so the dashboard never displays invented numbers. Wire real adapters in here.
function getPlatformOrders(source, dateStr) {
  return {
    source,
    date: dateStr,
    connected: false,
    message: `${source} integration not configured`,
    orders: [],
    summary: {
      totalOrders: 0,
      totalRevenue: 0,
      avgOrderValue: 0,
      connected: false
    }
  };
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
    const orders = await getToastOrders(dateStr);
    const totalRevenue = orders.reduce((sum, o) => sum + computeNetRevenue(o), 0);
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
    const orders = await getToastOrders(today);
    const totalRevenue = orders.reduce((s, o) => s + computeNetRevenue(o), 0);
    posSummary = {
      totalOrders: orders.length,
      totalRevenue: parseFloat(totalRevenue.toFixed(2))
    };
  } catch (e) { /* POS may fail — leave zeroes */ }
  const dd = getPlatformOrders('doordash', today).summary;
  const ue = getPlatformOrders('ubereats', today).summary;
  const gh = getPlatformOrders('grubhub', today).summary;
  // Third-party platforms are not yet integrated; totals reflect only Toast POS.
  // Once adapters land, replace with sum of dd/ue/gh.totalRevenue.
  const combinedRevenue = posSummary.totalRevenue;
  const combinedOrders = posSummary.totalOrders;
  res.json({
    date: today,
    pos: posSummary,
    doordash: dd,
    ubereats: ue,
    grubhub: gh,
    thirdParty: {
      totalOrders: 0,
      totalRevenue: 0,
      connected: { doordash: false, ubereats: false, grubhub: false }
    },
    combined: {
      totalOrders: combinedOrders,
      totalRevenue: parseFloat(combinedRevenue.toFixed(2)),
      avgOrderValue: combinedOrders > 0 ? parseFloat((combinedRevenue / combinedOrders).toFixed(2)) : 0,
      connected: { doordash: false, ubereats: false, grubhub: false }
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
  // Defaults from env vars — restaurant_name is always available.
  // POS credentials (Toast client id/secret) are NEVER returned by this endpoint.
  const defaults = {
    restaurant_name: RESTAURANT_NAME,
    restaurant_phone: process.env.RESTAURANT_PHONE || '',
    tax_rate: 0.06625,
    doordash_commission: 0.30,
    ubereats_commission: 0.30,
    grubhub_commission: 0.275,
    toast_configured: Boolean(process.env.TOAST_CLIENT_ID && process.env.TOAST_CLIENT_SECRET)
  };
  if (!pool) return res.json(defaults);
  try {
    const r = await dbQuery('SELECT * FROM settings');
    const out = { ...defaults };
    r.rows.forEach(row => { out[row.key] = row.value; });
    res.json(out);
  } catch (e) { res.json(defaults); }
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
  // Real Toast history for the last N days. Third-party platforms are still
  // placeholders (connected: false) until their adapters ship.
  const { days = 7 } = req.query;
  const numDays = Math.min(Math.max(parseInt(days) || 7, 1), 30);
  const out = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = formatDate(d);
    const summary = await getToastDaySummary(dateStr);
    out.push({
      date: d.toISOString().split('T')[0],
      pos: summary.revenue,
      doordash: 0,
      ubereats: 0,
      grubhub: 0,
      total: summary.revenue,
      orders: summary.orders
    });
  }
  res.json(out);
});

app.get('/api/reports/top-items', async (req, res) => {
  // Real top items require either (a) menu in DB + Toast order line aggregation,
  // or (b) Toast reporting API. Until then, return empty + flag so the UI doesn't
  // show invented numbers.
  if (!pool) return res.json({ items: [], connected: false, message: 'Menu database not configured' });
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
      return res.json({ items: [], connected: false, message: 'No menu items configured' });
    }
    // Counts/revenue per item need Toast reporting integration; placeholder zeros.
    const items = r.rows.map(it => ({
      id: it.id,
      name: it.name,
      price: parseFloat(it.price),
      cost: parseFloat(it.cost || 0),
      margin_pct: parseFloat(it.margin_pct),
      count: 0,
      revenue: 0,
      message: 'Per-item sales require Toast reporting integration'
    }));
    res.json({ items, connected: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/profit', async (req, res) => {
  // Toast POS revenue only — third-party platforms not integrated yet.
  try {
    const days = 30;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push(await getToastDaySummary(formatDate(d)));
    }
    const totalRevenue = out.reduce((s, d) => s + d.revenue, 0);
    const totalOrders = out.reduce((s, d) => s + d.orders, 0);

    // Industry-standard estimates until real COGS / labor are wired up.
    const foodCost = totalRevenue * 0.30; // ~30% food cost
    const laborEst = totalRevenue * 0.25; // ~25% labor cost
    const commission = 0; // no third-party until integrated
    const netProfit = totalRevenue - commission - foodCost - laborEst;

    res.json({
      period: 'last_30_days',
      revenue: parseFloat(totalRevenue.toFixed(2)),
      orders: totalOrders,
      source: 'toast_pos',
      costs: {
        third_party_commission: parseFloat(commission.toFixed(2)),
        food_cost: parseFloat(foodCost.toFixed(2)),
        labor: parseFloat(laborEst.toFixed(2))
      },
      net_profit: parseFloat(netProfit.toFixed(2)),
      margin_pct: totalRevenue > 0 ? parseFloat(((netProfit / totalRevenue) * 100).toFixed(1)) : 0
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

// Export for serverless platforms (Netlify Functions wrap this with serverless-http).
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Restaurant dashboard running on ${PORT}`));
}
