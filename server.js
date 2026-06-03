require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Toast POS Config ─────────────────────────────────────────────────────────
const TOAST_API_BASE = 'https://ws-api.toasttab.com';
const TOAST_AUTH_URL = `${TOAST_API_BASE}/authentication/v1/authentication/login`;
const TOAST_ORDERS_URL = `${TOAST_API_BASE}/orders/v1/orders`;
const RESTAURANT_GUID = '8d0d8d7b-1fcc-43fd-8be5-1413efbaaef7';

// ─── In-memory token cache ───────────────────────────────────────────────────
let toastToken = null;
let tokenExpiry = 0;

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
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': RESTAURANT_GUID
    }
  });
  if (!res.ok) throw new Error(`Toast orders failed: ${res.status}`);
  return await res.json();
}

// ─── Platform mock data (replace with real API calls in production) ─────────────
function getPlatformOrders(source, dateStr) {
  const seed = dateStr.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = (n) => (seed * 9301 + 49297) % 233280 / 233280 * n;
  const configs = {
    doordash: { avgTicket: 28, ordersPerDay: 45 },
    ubereats: { avgTicket: 32, ordersPerDay: 38 },
    grubhub: { avgTicket: 25, ordersPerDay: 22 }
  };
  const cfg = configs[source];
  if (!cfg) return { source, date: dateStr, orders: [], summary: { totalOrders: 0, totalRevenue: 0 } };
  const totalOrders = Math.floor(rand(cfg.ordersPerDay));
  const totalRevenue = parseFloat((totalOrders * cfg.avgTicket * (0.9 + rand(0.2))).toFixed(2));
  const avgOrderValue = totalOrders > 0 ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0;
  const statuses = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'ACCEPTED', 'PREPARING'];
  const orders = [];
  for (let i = 0; i < totalOrders; i++) {
    const hour = 10 + Math.floor(rand(14));
    const minute = Math.floor(rand(60));
    orders.push({
      orderId: `${source.toUpperCase().slice(0, 2)}-ORD-${dateStr}-${i + 100}`,
      placedAt: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
      status: statuses[Math.floor(rand(statuses.length))],
      items: Math.floor(rand(5)) + 1,
      subtotal: parseFloat((rand(cfg.avgTicket * 0.8) + cfg.avgTicket * 0.2).toFixed(2)),
      total: parseFloat((rand(cfg.avgTicket) + cfg.avgTicket * 0.5).toFixed(2))
    });
  }
  return { source, date: dateStr, orders, summary: { totalOrders, totalRevenue, avgOrderValue } };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

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

// Platforms
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

// Stats summary
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
    date: today,
    pos: posSummary,
    doordash: dd,
    ubereats: ue,
    grubhub: gh,
    thirdParty: { totalOrders: thirdPartyOrders, totalRevenue: parseFloat(thirdPartyTotal.toFixed(2)) },
    combined: {
      totalOrders: combinedOrders,
      totalRevenue: parseFloat(combinedRevenue.toFixed(2)),
      avgOrderValue: combinedOrders > 0 ? parseFloat((combinedRevenue / combinedOrders).toFixed(2)) : 0
    }
  });
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'frontend')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaurant dashboard running on ${PORT}`));
