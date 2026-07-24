// Netlify Function wrapper for the Express server.
// Routes:  /.netlify/functions/api/<express-route>
//
// Why this exists: the dashboard is hosted on Netlify, which serves static
// assets only. Without this wrapper, /api/* requests 404 and the frontend
// falls back to seeded random "demo" data. This file bridges Express to
// Netlify Functions so all server-side fixes (Toast pagination, net
// revenue, voided-order filtering, real reports) actually execute.
const serverless = require('serverless-http');
const app = require('../../server.js');

module.exports.handler = serverless(app, {
  // Bump basePath so internal redirects and static serving don't get
  // confused by the /functions prefix.
  basePath: '',
});
