/**
 * THE CLOSET - Cloudflare Worker Backend
 * Handles all API endpoints for product management, cart, and ordering
 */

// ===========================
// ROUTER & UTILITIES
// ===========================

class Router {
  constructor() {
    this.routes = [];
  }

  get(path, handler) {
    this.routes.push({ method: 'GET', path, handler });
  }

  post(path, handler) {
    this.routes.push({ method: 'POST', path, handler });
  }

  put(path, handler) {
    this.routes.push({ method: 'PUT', path, handler });
  }

  delete(path, handler) {
    this.routes.push({ method: 'DELETE', path, handler });
  }

  async route(req, env) {
    const url = new URL(req.url);
    const method = req.method;
    const pathname = url.pathname;

    for (const route of this.routes) {
      const pattern = new RegExp(`^${route.path.replace(/:[^/]+/g, '([^/]+)')}/?$`);
      const match = pathname.match(pattern);

      if (match && route.method === method) {
        const params = {};
        const paramNames = route.path.match(/:[^/]+/g) || [];
        paramNames.forEach((name, i) => {
          params[name.slice(1)] = match[i + 1];
        });
        req.params = params;
        return await route.handler(req, env);
      }
    }

    return json({ error: 'Not found' }, 404);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function parseJSON(req) {
  try {
    return await req.json();
  } catch (e) {
    throw new Error('Invalid JSON');
  }
}

// ===========================
// DATABASE UTILITIES
// ===========================

async function initDB(env) {
  // If using D1 (Cloudflare's SQLite), initialize tables if they don't exist
  if (env.DB) {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        imageUrl TEXT,
        sizes TEXT,
        section TEXT,
        discountEnabled INTEGER DEFAULT 0,
        discountPercent REAL DEFAULT 0,
        outOfStock INTEGER DEFAULT 0,
        displayOrder INTEGER DEFAULT 0,
        createdAt TEXT,
        updatedAt TEXT
      )
    `).run().catch(() => {}); // Ignore if table already exists

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        createdAt TEXT
      )
    `).run().catch(() => {});

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        discountType TEXT NOT NULL DEFAULT 'percent',
        discountValue REAL NOT NULL DEFAULT 0,
        maxUses INTEGER DEFAULT 0,
        usedCount INTEGER DEFAULT 0,
        expiryDate TEXT,
        active INTEGER DEFAULT 1,
        createdAt TEXT,
        updatedAt TEXT
      )
    `).run().catch(() => {});
  }
}

// ===========================
// MIDDLEWARE
// ===========================

function validateToken(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');

  if (!token) {
    throw new Error('Unauthorized: No token provided');
  }

  // In production, verify the token (you'll need to implement token generation in /api/login)
  // For now, we'll accept any token that was issued by /api/login
  return token;
}

// ===========================
// ROUTES
// ===========================

const router = new Router();

// LOGIN - Generate auth token
router.post('/api/login', async (req, env) => {
  const body = await parseJSON(req);
  const { password } = body;

  if (!password) {
    return json({ error: 'Password required' }, 400);
  }

  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'admin123';

  if (password !== ADMIN_PASSWORD) {
    return json({ error: 'Invalid password' }, 401);
  }

  // Generate a simple token (in production, use JWT)
  const token = `token_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  return json({ token, message: 'Logged in successfully' });
});

// GET ALL PRODUCTS (sorted by displayOrder)
router.get('/api/products', async (req, env) => {
  if (!env.DB) {
    return json({ products: [] });
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM products ORDER BY displayOrder ASC, createdAt ASC'
    ).all();

    const products = results.map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      imageUrl: p.imageUrl,
      sizes: p.sizes ? JSON.parse(p.sizes) : [],
      section: p.section,
      discountEnabled: p.discountEnabled === 1,
      discountPercent: p.discountPercent,
      outOfStock: p.outOfStock === 1,
      displayOrder: p.displayOrder,
      createdAt: p.createdAt,
    }));

    return json({ products });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// CREATE PRODUCT
router.post('/api/products', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const body = await parseJSON(req);
    const { name, price, imageUrl, sizes, section, discountEnabled, discountPercent, outOfStock } = body;

    if (!name || !price) {
      return json({ error: 'Name and price are required' }, 400);
    }

    const id = `prod_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();

    // Get the next displayOrder
    const { results: countResults } = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM products'
    ).all();
    const displayOrder = countResults[0]?.count || 0;

    await env.DB.prepare(
      `INSERT INTO products (id, name, price, imageUrl, sizes, section, discountEnabled, discountPercent, outOfStock, displayOrder, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      name,
      price,
      imageUrl,
      JSON.stringify(sizes || []),
      section || '',
      discountEnabled ? 1 : 0,
      discountPercent || 0,
      outOfStock ? 1 : 0,
      displayOrder,
      now,
      now
    ).run();

    return json({ id, message: 'Product created' }, 201);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// UPDATE PRODUCT
router.put('/api/products/:id', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const { id } = req.params;
    const body = await parseJSON(req);
    const { name, price, imageUrl, sizes, section, discountEnabled, discountPercent, outOfStock } = body;
    const now = new Date().toISOString();

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (price !== undefined) {
      updates.push('price = ?');
      values.push(price);
    }
    if (imageUrl !== undefined) {
      updates.push('imageUrl = ?');
      values.push(imageUrl);
    }
    if (sizes !== undefined) {
      updates.push('sizes = ?');
      values.push(JSON.stringify(sizes));
    }
    if (section !== undefined) {
      updates.push('section = ?');
      values.push(section);
    }
    if (discountEnabled !== undefined) {
      updates.push('discountEnabled = ?');
      values.push(discountEnabled ? 1 : 0);
    }
    if (discountPercent !== undefined) {
      updates.push('discountPercent = ?');
      values.push(discountPercent);
    }
    if (outOfStock !== undefined) {
      updates.push('outOfStock = ?');
      values.push(outOfStock ? 1 : 0);
    }

    if (updates.length === 0) {
      return json({ error: 'No fields to update' }, 400);
    }

    updates.push('updatedAt = ?');
    values.push(now);
    values.push(id);

    const query = `UPDATE products SET ${updates.join(', ')} WHERE id = ?`;
    await env.DB.prepare(query).bind(...values).run();

    return json({ message: 'Product updated' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// DELETE PRODUCT
router.delete('/api/products/:id', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const { id } = req.params;
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
    return json({ message: 'Product deleted' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// REORDER PRODUCTS
router.post('/api/products/reorder', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const body = await parseJSON(req);
    const { order } = body;

    if (!Array.isArray(order)) {
      return json({ error: 'order must be an array of product IDs' }, 400);
    }

    const now = new Date().toISOString();

    // Update displayOrder for each product
    for (let i = 0; i < order.length; i++) {
      await env.DB.prepare(
        'UPDATE products SET displayOrder = ?, updatedAt = ? WHERE id = ?'
      ).bind(i, now, order[i]).run();
    }

    return json({ message: 'Products reordered successfully' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// GET ALL SECTIONS
router.get('/api/sections', async (req, env) => {
  if (!env.DB) {
    return json({ sections: [] });
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT id, name, slug FROM sections ORDER BY createdAt ASC'
    ).all();

    const sections = results.map(s => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
    }));

    return json({ sections });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// CREATE SECTION
router.post('/api/sections', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const body = await parseJSON(req);
    const { name } = body;

    if (!name) {
      return json({ error: 'Name is required' }, 400);
    }

    const slug = name.toLowerCase().replace(/\s+/g, '-');
    const now = new Date().toISOString();

    await env.DB.prepare(
      'INSERT INTO sections (name, slug, createdAt) VALUES (?, ?, ?)'
    ).bind(name, slug, now).run();

    return json({ message: 'Section created' }, 201);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return json({ error: 'Section already exists' }, 409);
    }
    return json({ error: err.message }, 500);
  }
});

// DELETE SECTION
router.delete('/api/sections/:id', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const { id } = req.params;
    await env.DB.prepare('DELETE FROM sections WHERE id = ?').bind(id).run();
    return json({ message: 'Section deleted' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// GET ALL PROMO CODES
router.get('/api/promo-codes', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ promoCodes: [] });
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM promo_codes ORDER BY createdAt DESC'
    ).all();

    const promoCodes = results.map(p => ({
      id: p.id,
      code: p.code,
      discountType: p.discountType,
      discountValue: p.discountValue,
      maxUses: p.maxUses,
      usedCount: p.usedCount,
      expiryDate: p.expiryDate,
      active: p.active === 1,
      createdAt: p.createdAt,
    }));

    return json({ promoCodes });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// CREATE PROMO CODE
router.post('/api/promo-codes', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const body = await parseJSON(req);
    const { code, discountType, discountValue, maxUses, expiryDate, active } = body;

    if (!code || !String(code).trim()) {
      return json({ error: 'Code is required' }, 400);
    }
    if (!['percent', 'fixed'].includes(discountType)) {
      return json({ error: 'discountType must be "percent" or "fixed"' }, 400);
    }
    const value = Number(discountValue);
    if (!Number.isFinite(value) || value <= 0) {
      return json({ error: 'discountValue must be a positive number' }, 400);
    }
    if (discountType === 'percent' && value > 100) {
      return json({ error: 'Percent discount cannot exceed 100' }, 400);
    }

    const id = `promo_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();
    const normalizedCode = String(code).trim().toUpperCase();
    const maxUsesNum = Math.max(0, Math.floor(Number(maxUses) || 0));

    await env.DB.prepare(
      `INSERT INTO promo_codes (id, code, discountType, discountValue, maxUses, usedCount, expiryDate, active, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).bind(
      id,
      normalizedCode,
      discountType,
      value,
      maxUsesNum,
      expiryDate || null,
      active === false ? 0 : 1,
      now,
      now
    ).run();

    return json({ id, message: 'Promo code created' }, 201);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return json({ error: 'A promo code with this code already exists' }, 409);
    }
    return json({ error: err.message }, 500);
  }
});

// UPDATE PROMO CODE
router.put('/api/promo-codes/:id', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const { id } = req.params;
    const body = await parseJSON(req);
    const { code, discountType, discountValue, maxUses, expiryDate, active } = body;
    const now = new Date().toISOString();

    const updates = [];
    const values = [];

    if (code !== undefined) {
      if (!String(code).trim()) {
        return json({ error: 'Code cannot be empty' }, 400);
      }
      updates.push('code = ?');
      values.push(String(code).trim().toUpperCase());
    }
    if (discountType !== undefined) {
      if (!['percent', 'fixed'].includes(discountType)) {
        return json({ error: 'discountType must be "percent" or "fixed"' }, 400);
      }
      updates.push('discountType = ?');
      values.push(discountType);
    }
    if (discountValue !== undefined) {
      const value = Number(discountValue);
      if (!Number.isFinite(value) || value <= 0) {
        return json({ error: 'discountValue must be a positive number' }, 400);
      }
      updates.push('discountValue = ?');
      values.push(value);
    }
    if (maxUses !== undefined) {
      updates.push('maxUses = ?');
      values.push(Math.max(0, Math.floor(Number(maxUses) || 0)));
    }
    if (expiryDate !== undefined) {
      updates.push('expiryDate = ?');
      values.push(expiryDate || null);
    }
    if (active !== undefined) {
      updates.push('active = ?');
      values.push(active ? 1 : 0);
    }

    if (updates.length === 0) {
      return json({ error: 'No fields to update' }, 400);
    }

    updates.push('updatedAt = ?');
    values.push(now);
    values.push(id);

    const query = `UPDATE promo_codes SET ${updates.join(', ')} WHERE id = ?`;
    await env.DB.prepare(query).bind(...values).run();

    return json({ message: 'Promo code updated' });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return json({ error: 'A promo code with this code already exists' }, 409);
    }
    return json({ error: err.message }, 500);
  }
});

// DELETE PROMO CODE
router.delete('/api/promo-codes/:id', async (req, env) => {
  validateToken(req, env);

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const { id } = req.params;
    await env.DB.prepare('DELETE FROM promo_codes WHERE id = ?').bind(id).run();
    return json({ message: 'Promo code deleted' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// VALIDATE PROMO CODE (public - used at checkout)
router.post('/api/promo-codes/validate', async (req, env) => {
  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  try {
    const body = await parseJSON(req);
    const { code } = body;

    if (!code || !String(code).trim()) {
      return json({ error: 'Code is required' }, 400);
    }

    const normalizedCode = String(code).trim().toUpperCase();

    const { results } = await env.DB.prepare(
      'SELECT * FROM promo_codes WHERE UPPER(code) = ?'
    ).bind(normalizedCode).all();

    const promo = results[0];

    if (!promo) {
      return json({ error: 'Invalid promo code' }, 404);
    }
    if (promo.active !== 1) {
      return json({ error: 'This promo code is no longer active' }, 400);
    }
    if (promo.expiryDate) {
      const expiry = new Date(promo.expiryDate);
      // Codes remain valid through the end of the expiry day
      expiry.setHours(23, 59, 59, 999);
      if (expiry.getTime() < Date.now()) {
        return json({ error: 'This promo code has expired' }, 400);
      }
    }
    if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
      return json({ error: 'This promo code has reached its usage limit' }, 400);
    }

    return json({
      valid: true,
      code: promo.code,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// HEALTH CHECK
router.get('/health', async (req, env) => {
  return json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===========================
// MAIN HANDLER
// ===========================

export default {
  async fetch(request, env, ctx) {
    // Initialize database
    await initDB(env);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    try {
      const response = await router.route(request, env);

      // Add CORS headers to response
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      return response;
    } catch (err) {
      return json(
        { error: err.message || 'Internal server error' },
        err.message.includes('Unauthorized') ? 401 : 500
      );
    }
  },
};
