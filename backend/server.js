require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Toast POS Config ───────────────────────────────────────────────────────────
const TOAST_API_BASE = 'https://ws-api.toasttab.com';
const TOAST_AUTH_URL = `${TOAST_API_BASE}/authentication/v1/authentication/login`;
const TOAST_ORDERS_URL = `${TOAST_API_BASE}/orders/v1/orders`;
const RESTAURANT_GUID = '8d0d8d7b-1fcc-43fd-8be5-1413efbaaef7';

// ─── In-memory token cache ─────────────────────────────────────────────────────
let toastToken = null;
let tokenExpiry = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(date) {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

function todayStr() {
  return formatDate(new Date());
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Toast auth failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  toastToken = data.token.accessToken;
  // Token valid for 24h — cache with 23h buffer
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return toastToken;
}

async function getToastOrders(dateStr) {
  const token = await getToastToken();
  const url = `${TOAST_ORDERS_URL}?restaurantGuid=${RESTAURANT_GUID}&businessDate=${dateStr}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': RESTAURANT_GUID
    }
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Toast orders failed: ${res.status} ${err}`);
  }

  return await res.json();
}

// ─── Third-Party Platform Mock Data ───────────────────────────────────────────
// In production: integrate with DoorDash Drive API, Uber Eats API, Grubhub API
// For now: realistic mock data based on typical restaurant order volumes
function getPlatformOrders(source, dateStr) {
  // Seed pseudo-random based on date so data is consistent per day
  const seed = dateStr.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = (n) => (seed * 9301 + 49297) % 233280 / 233280 * n;

  const configs = {
    doordash: { avgTicket: 28, ordersPerDay: 45 },
    ubereats: { avgTicket: 32, ordersPerDay: 38 },
    grubhub:   { avgTicket: 25, ordersPerDay: 22 }
  };

  const cfg = configs[source];
  if (!cfg) return { source, date: dateStr, orders: [], summary: { totalOrders: 0, totalRevenue: 0 } };

  const totalOrders = Math.floor(rand(cfg.ordersPerDay));
  const totalRevenue = parseFloat((totalOrders * cfg.avgTicket * (0.9 + rand(0.2))).toFixed(2));
  const avgOrderValue = totalOrders > 0 ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0;

  const statuses = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'ACCEPTED', 'PREPARING'];
  const orders = [];
  for (let i = 0; i < totalOrders; i++) {
    const hour = 10 + Math.floor(rand(14)); // 10am - 11pm
    const minute = Math.floor(rand(60));
    const orderTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    orders.push({
      orderId: `${source.toUpperCase().slice(0, 2)}-ORD-${dateStr}-${(i + 100).toString()}`,
      placedAt: orderTime,
      status: statuses[Math.floor(rand(statuses.length))],
      items: Math.floor(rand(5)) + 1,
      subtotal: parseFloat((rand(cfg.avgTicket * 0.8) + cfg.avgTicket * 0.2).toFixed(2)),
      tax: parseFloat((rand(cfg.avgTicket * 0.1)).toFixed(2)),
      deliveryFee: source === 'doordash' ? 0 : (source === 'ubereats' ? 0 : 0),
      total: parseFloat((rand(cfg.avgTicket) + cfg.avgTicket * 0.5).toFixed(2)),
      customer: source === 'doordash' ? 'DoorDash Customer' : source === 'ubereats' ? 'Uber Eats Customer' : 'Grubhub Customer'
    });
  }

  return {
    source,
    date: dateStr,
    orders,
    summary: { totalOrders, totalRevenue, avgOrderValue }
  };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── POS / Toast ───────────────────────────────────────────────────────────────
app.get('/api/pos/today', async (req, res) => {
  try {
    const data = await getToastOrders(todayStr());
    const orders = data.orders || [];

    const totalRevenue = orders.reduce((sum, o) => sum + (parseFloat(o.totalAmount) || 0), 0);
    const totalOrders = orders.length;
    const avgOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // Payment types breakdown
    const paymentTypes = {};
    orders.forEach(o => {
      const pmt = o.paymentInfo?.[0]?.paymentType || 'UNKNOWN';
      paymentTypes[pmt] = (paymentTypes[pmt] || 0) + 1;
    });

    // Hourly breakdown
    const hourly = {};
    orders.forEach(o => {
      const hour = (o.createdAt || '').split('T')[2]?.split(':')[0] || '00';
      hourly[hour] = (hourly[hour] || 0) + 1;
    });

    res.json({
      source: 'toast_pos',
      date: todayStr(),
      orders,
      summary: {
        totalOrders,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        avgOrderValue: parseFloat(avgOrder.toFixed(2)),
        paymentTypes,
        hourly
      }
    });
  } catch (err) {
    console.error('Toast POS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pos/yesterday', async (req, res) => {
  try {
    const data = await getToastOrders(yesterdayStr());
    const orders = data.orders || [];
    const totalRevenue = orders.reduce((sum, o) => sum + (parseFloat(o.totalAmount) || 0), 0);
    const totalOrders = orders.length;
    res.json({
      source: 'toast_pos',
      date: yesterdayStr(),
      orders,
      summary: { totalOrders, totalRevenue: parseFloat(totalRevenue.toFixed(2)) }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pos/range', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end dates required (YYYYMMDD)' });
  try {
    const data = await getToastOrders(start);
    const orders = data.orders || [];
    const totalRevenue = orders.reduce((sum, o) => sum + (parseFloat(o.totalAmount) || 0), 0);
    res.json({ source: 'toast_pos', date: start, orders, summary: { totalOrders: orders.length, totalRevenue: parseFloat(totalRevenue.toFixed(2)) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DoorDash ───────────────────────────────────────────────────────────────────
app.get('/api/doordash/today', (req, res) => {
  res.json(getPlatformOrders('doordash', todayStr()));
});

app.get('/api/doordash/yesterday', (req, res) => {
  res.json(getPlatformOrders('doordash', yesterdayStr()));
});

// ── Uber Eats ──────────────────────────────────────────────────────────────────
app.get('/api/ubereats/today', (req, res) => {
  res.json(getPlatformOrders('ubereats', todayStr()));
});

app.get('/api/ubereats/yesterday', (req, res) => {
  res.json(getPlatformOrders('ubereats', yesterdayStr()));
});

// ── Grubhub ─────────────────────────────────────────────────────────────────────
app.get('/api/grubhub/today', (req, res) => {
  res.json(getPlatformOrders('grubhub', todayStr()));
});

app.get('/api/grubhub/yesterday', (req, res) => {
  res.json(getPlatformOrders('grubhub', yesterdayStr()));
});

// ── Aggregated Stats ───────────────────────────────────────────────────────────
app.get('/api/stats/summary', async (req, res) => {
  const today = todayStr();
  const yesterday = yesterdayStr();

  try {
    // Toast POS
    let posToday = { summary: { totalOrders: 0, totalRevenue: 0 } };
    try {
      const data = await getToastOrders(today);
      const orders = data.orders || [];
      const totalRevenue = orders.reduce((sum, o) => sum + (parseFloat(o.totalAmount) || 0), 0);
      posToday = { summary: { totalOrders: orders.length, totalRevenue: parseFloat(totalRevenue.toFixed(2)) } };
    } catch (e) { /* POS may be down */ }

    // Third-party platforms (mock)
    const ddToday = getPlatformOrders('doordash', today).summary;
    const ueToday = getPlatformOrders('ubereats', today).summary;
    const ghToday = getPlatformOrders('grubhub', today).summary;

    const thirdPartyTotal = ddToday.totalRevenue + ueToday.totalRevenue + ghToday.totalRevenue;
    const thirdPartyOrders = ddToday.totalOrders + ueToday.totalOrders + ghToday.totalOrders;

    const combinedRevenue = posToday.summary.totalRevenue + thirdPartyTotal;
    const combinedOrders = posToday.summary.totalOrders + thirdPartyOrders;

    res.json({
      date: today,
      pos: posToday.summary,
      doordash: ddToday,
      ubereats: ueToday,
      grubhub: ghToday,
      thirdParty: { totalOrders: thirdPartyOrders, totalRevenue: parseFloat(thirdPartyTotal.toFixed(2)) },
      combined: {
        totalOrders: combinedOrders,
        totalRevenue: parseFloat(combinedRevenue.toFixed(2)),
        avgOrderValue: combinedOrders > 0 ? parseFloat((combinedRevenue / combinedOrders).toFixed(2)) : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve Frontend Static Files ───────────────────────────────────────────────
app.use(express.static('../frontend'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaurant dashboard running on port ${PORT}`));
