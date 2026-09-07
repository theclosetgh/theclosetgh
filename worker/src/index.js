export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ================= CORS =================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders });
    }

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    // ================= HELPERS =================
    function slugify(str) {
      return String(str)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    }

    // ================= AUTH =================
    async function sign(payload) {
      const enc = new TextEncoder();
      const secret = String(env.SESSION_SECRET || "");
      if (!secret) throw new Error("Missing SESSION_SECRET");

      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
      return btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    }

    async function makeToken(role, expMs) {
      const payload = role + "|" + String(expMs);
      const sig = await sign(payload);
      return payload + "." + sig;
    }

    async function verifyToken(token) {
      if (!token) return false;
      const parts = token.split(".");
      if (parts.length !== 2) return false;

      const payload = parts[0];
      const sig = parts[1];
      if (sig !== (await sign(payload))) return false;

      const [role, exp] = payload.split("|");
      if (role !== "admin") return false;
      if (Date.now() > Number(exp)) return false;

      return true;
    }

    function getBearerToken(req) {
      const h = req.headers.get("Authorization") || "";
      return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
    }

    async function requireAuth(req) {
      return await verifyToken(getBearerToken(req));
    }

    // ================= ROUTES =================

    if (url.pathname === "/api/health") return json({ ok: true });

    // ---------- LOGIN ----------
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (String(body.password) !== String(env.ADMIN_PASSWORD)) {
        return json({ ok: false, error: "Invalid password" }, 401);
      }
      const token = await makeToken(
        "admin",
        Date.now() + 7 * 24 * 60 * 60 * 1000
      );
      return json({ ok: true, token });
    }

    // ---------- SECTIONS (PUBLIC) ----------
    if (url.pathname === "/api/sections" && request.method === "GET") {
      const r = await env.DB
        .prepare("SELECT id,name,slug FROM sections ORDER BY position ASC")
        .all();
      return json({ ok: true, sections: r.results || [] });
    }

    // ---------- SECTIONS (ADMIN CREATE) ----------
    if (url.pathname === "/api/sections" && request.method === "POST") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      if (!name) return json({ ok: false, error: "Name required" }, 400);

      const slug = slugify(name);
      const last = await env.DB
        .prepare("SELECT MAX(position) as max FROM sections")
        .first();
      const position = (last?.max ?? 0) + 1;

      await env.DB
        .prepare(
          "INSERT INTO sections (name,slug,position) VALUES (?,?,?)"
        )
        .bind(name, slug, position)
        .run();

      return json({ ok: true });
    }

    // ---------- SECTIONS DELETE ----------
    if (url.pathname.startsWith("/api/sections/") && request.method === "DELETE") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const id = url.pathname.split("/").pop();
      await env.DB.prepare("DELETE FROM sections WHERE id=?").bind(id).run();
      return json({ ok: true });
    }

    // ---------- SECTIONS REORDER ----------
    if (url.pathname === "/api/sections/reorder" && request.method === "PUT") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const { order } = await request.json();
      await env.DB.batch(
        order.map((s) =>
          env.DB
            .prepare("UPDATE sections SET position=? WHERE id=?")
            .bind(s.position, s.id)
        )
      );
      return json({ ok: true });
    }

    // ---------- PRODUCTS (PUBLIC) ----------
    if (url.pathname === "/api/products" && request.method === "GET") {
      const r = await env.DB
        .prepare("SELECT * FROM products ORDER BY position ASC")
        .all();

      const products = (r.results || []).map((p) => ({
        id: p.id,
        name: p.name,
        price: Number(p.price),
        sizes: JSON.parse(p.sizes || "[]"),
        imageUrl: p.imageUrl,
        discountEnabled: !!p.discountEnabled,
        discountPercent: Number(p.discountPercent || 0),
        outOfStock: !!p.outOfStock,
        section: p.section || null,
        createdAt: p.createdAt,
      }));

      return json({ ok: true, products });
    }

    // ---------- PRODUCTS (ADMIN CREATE) ----------
    if (url.pathname === "/api/products" && request.method === "POST") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const body = await request.json();
      const id = crypto.randomUUID();

      const name = String(body.name).trim();
      const price = Math.round(Number(body.price));
      const sizes = body.sizes || [];
      const imageUrl = String(body.imageUrl).trim();
      const section = String(body.section || "").trim();

      if (!name || !imageUrl || !price || !sizes.length) {
        return json({ ok: false, error: "Invalid payload" }, 400);
      }

      const last = await env.DB
        .prepare("SELECT MAX(position) as max FROM products")
        .first();
      const position = (last?.max ?? -1) + 1;

      await env.DB
        .prepare(
          `INSERT INTO products
           (id,name,price,sizes,imageUrl,discountEnabled,discountPercent,outOfStock,section,position,createdAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          id,
          name,
          price,
          JSON.stringify(sizes),
          imageUrl,
          body.discountEnabled ? 1 : 0,
          Number(body.discountPercent || 0),
          body.outOfStock ? 1 : 0,
          section,
          position,
          new Date().toISOString()
        )
        .run();

      return json({ ok: true, id });
    }

    // ---------- PRODUCTS REORDER ----------
    if (url.pathname === "/api/products/reorder" && request.method === "POST") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const { order } = await request.json().catch(() => ({}));
      if (!Array.isArray(order)) {
        return json({ ok: false, error: "order must be an array of ids" }, 400);
      }

      await env.DB.batch(
        order.map((id, index) =>
          env.DB
            .prepare("UPDATE products SET position=? WHERE id=?")
            .bind(index, id)
        )
      );

      return json({ ok: true });
    }

    // ---------- PRODUCTS (ADMIN UPDATE) ----------
    if (url.pathname.startsWith("/api/products/") && request.method === "PUT") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const id = url.pathname.split("/").pop();
      const body = await request.json();
      const current = await env.DB
        .prepare("SELECT * FROM products WHERE id=?")
        .bind(id)
        .first();

      if (!current) return json({ ok: false, error: "Not found" }, 404);

      await env.DB
        .prepare(
          `UPDATE products SET
           name=?, price=?, sizes=?, imageUrl=?,
           discountEnabled=?, discountPercent=?, outOfStock=?, section=?
           WHERE id=?`
        )
        .bind(
          body.name ?? current.name,
          body.price ?? current.price,
          JSON.stringify(body.sizes ?? JSON.parse(current.sizes)),
          body.imageUrl ?? current.imageUrl,
          body.discountEnabled ?? current.discountEnabled,
          body.discountPercent ?? current.discountPercent,
          body.outOfStock ?? current.outOfStock,
          body.section ?? current.section,
          id
        )
        .run();

      return json({ ok: true });
    }

    // ---------- PRODUCTS (ADMIN DELETE) ----------
    if (url.pathname.startsWith("/api/products/") && request.method === "DELETE") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const id = url.pathname.split("/").pop();
      await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
      return json({ ok: true });
    }

    // ================= PROMO CODES =================

    // ---------- GET ALL PROMO CODES (ADMIN) ----------
    if (url.pathname === "/api/promo-codes" && request.method === "GET") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const r = await env.DB
        .prepare("SELECT * FROM promo_codes ORDER BY createdAt DESC")
        .all();

      const promoCodes = (r.results || []).map((p) => ({
        id: p.id,
        code: p.code,
        discountType: p.discountType,
        discountValue: Number(p.discountValue),
        maxUses: Number(p.maxUses),
        usedCount: Number(p.usedCount),
        expiryDate: p.expiryDate,
        active: !!p.active,
        createdAt: p.createdAt,
      }));

      return json({ ok: true, promoCodes });
    }

    // ---------- CREATE PROMO CODE (ADMIN) ----------
    if (url.pathname === "/api/promo-codes" && request.method === "POST") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const body = await request.json().catch(() => ({}));
      const { code, discountType, discountValue, maxUses, expiryDate } = body;

      if (!code || !discountType || !discountValue) {
        return json({ ok: false, error: "Missing required fields" }, 400);
      }

      if (!["percent", "fixed"].includes(discountType)) {
        return json(
          { ok: false, error: "Invalid discountType" },
          400
        );
      }

      const id = crypto.randomUUID();
      const normalizedCode = String(code).trim().toUpperCase();

      await env.DB
        .prepare(
          `INSERT INTO promo_codes
           (id, code, discountType, discountValue, maxUses, usedCount, expiryDate, active, createdAt)
           VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`
        )
        .bind(
          id,
          normalizedCode,
          discountType,
          Number(discountValue),
          Math.max(0, Math.floor(Number(maxUses) || 0)),
          expiryDate || null,
          new Date().toISOString()
        )
        .run();

      return json({ ok: true, id });
    }

    // ---------- UPDATE PROMO CODE (ADMIN) ----------
    if (url.pathname.startsWith("/api/promo-codes/") && url.pathname !== "/api/promo-codes/validate" && request.method === "PUT") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const id = url.pathname.split("/").pop();
      const body = await request.json().catch(() => ({}));

      const updates = [];
      const values = [];

      if (body.code !== undefined) {
        updates.push("code = ?");
        values.push(String(body.code).trim().toUpperCase());
      }
      if (body.discountType !== undefined) {
        updates.push("discountType = ?");
        values.push(body.discountType);
      }
      if (body.discountValue !== undefined) {
        updates.push("discountValue = ?");
        values.push(Number(body.discountValue));
      }
      if (body.maxUses !== undefined) {
        updates.push("maxUses = ?");
        values.push(Math.max(0, Math.floor(Number(body.maxUses) || 0)));
      }
      if (body.expiryDate !== undefined) {
        updates.push("expiryDate = ?");
        values.push(body.expiryDate || null);
      }
      if (body.active !== undefined) {
        updates.push("active = ?");
        values.push(body.active ? 1 : 0);
      }

      if (updates.length === 0) {
        return json({ ok: false, error: "No fields to update" }, 400);
      }

      values.push(id);
      const query = `UPDATE promo_codes SET ${updates.join(", ")} WHERE id = ?`;
      await env.DB.prepare(query).bind(...values).run();

      return json({ ok: true });
    }

    // ---------- DELETE PROMO CODE (ADMIN) ----------
    if (url.pathname.startsWith("/api/promo-codes/") && url.pathname !== "/api/promo-codes/validate" && request.method === "DELETE") {
      if (!(await requireAuth(request)))
        return json({ ok: false, error: "Unauthorized" }, 401);

      const id = url.pathname.split("/").pop();
      await env.DB.prepare("DELETE FROM promo_codes WHERE id = ?").bind(id).run();

      return json({ ok: true });
    }

    // ---------- VALIDATE PROMO CODE (PUBLIC) ----------
    if (url.pathname === "/api/promo-codes/validate" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { code } = body;

      if (!code) {
        return json({ ok: false, error: "Code is required" }, 400);
      }

      const normalizedCode = String(code).trim().toUpperCase();
      const promo = await env.DB
        .prepare("SELECT * FROM promo_codes WHERE UPPER(code) = ? LIMIT 1")
        .bind(normalizedCode)
        .first();

      if (!promo) {
        return json({ ok: false, error: "Invalid promo code" }, 404);
      }

      if (!promo.active) {
        return json({ ok: false, error: "This promo code is no longer active" }, 400);
      }

      if (promo.expiryDate) {
        const expiry = new Date(promo.expiryDate);
        expiry.setHours(23, 59, 59, 999);
        if (expiry.getTime() < Date.now()) {
          return json({ ok: false, error: "This promo code has expired" }, 400);
        }
      }

      if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
        return json(
          { ok: false, error: "This promo code has reached its usage limit" },
          400
        );
      }

      return json({
        ok: true,
        valid: true,
        code: promo.code,
        discountType: promo.discountType,
        discountValue: Number(promo.discountValue),
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};
