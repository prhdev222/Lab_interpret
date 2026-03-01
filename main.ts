// Lab Interpreter — Deno Deploy + Turso Backend
// API Key is stored ONLY in environment variables, never sent to browser

import { createClient } from "npm:@libsql/client@0.14.0";

// ===== Turso DB =====
const tursoUrl = Deno.env.get("TURSO_URL");
if (!tursoUrl) {
  throw new Error("❌ TURSO_URL environment variable is required! Set it in Deno Deploy Settings → Environment Variables.");
}
const db = createClient({
  url: tursoUrl,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN") || undefined,
});

// ===== Init DB Tables =====
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      display_name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      pattern TEXT,
      monk_mode INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create default admin if no users exist
  const count = await db.execute("SELECT COUNT(*) as c FROM users");
  if (Number(count.rows[0].c) === 0) {
    const defaultPin = Deno.env.get("DEFAULT_ADMIN_PIN") || "1234";
    const hash = await hashPin(defaultPin);
    await db.execute({
      sql: "INSERT INTO users (username, pin_hash, role, display_name, is_admin) VALUES (?, ?, ?, ?, 1)",
      args: ["admin", hash, "admin", "ผู้ดูแลระบบ"],
    });
    console.log(`✅ Created default admin (PIN: ${defaultPin}) — CHANGE THIS!`);
  }
}

// ===== Crypto Helpers =====
async function hashPin(pin: string): Promise<string> {
  const salt = "lab-interpreter-v1"; // fixed salt, adequate for PIN
  const data = new TextEncoder().encode(pin + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ===== Session Store (Turso DB — persists across isolates) =====
async function cleanSessions() {
  await db.execute({ sql: "DELETE FROM sessions WHERE expires_at < ?", args: [Date.now()] });
}

// ===== CORS & Response Helpers =====
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function getSession(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const result = await db.execute({
    sql: "SELECT user_id, username, role, display_name, expires_at FROM sessions WHERE token = ?",
    args: [token],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (Number(row.expires_at) < Date.now()) {
    await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [token] });
    return null;
  }
  return { userId: Number(row.user_id), username: String(row.username), role: String(row.role), displayName: String(row.display_name) };
}

// ===== API Routes =====

// POST /api/login — verify PIN, return session token
async function handleLogin(req: Request) {
  const { username, pin } = await req.json();
  if (!username || !pin) return json({ error: "กรุณาใส่ชื่อผู้ใช้และ PIN" }, 400);

  const hash = await hashPin(pin);
  const result = await db.execute({
    sql: "SELECT id, username, role, display_name, is_admin FROM users WHERE username = ? AND pin_hash = ?",
    args: [username, hash],
  });

  if (result.rows.length === 0) {
    return json({ error: "ชื่อผู้ใช้หรือ PIN ไม่ถูกต้อง" }, 401);
  }

  const user = result.rows[0];
  const token = generateToken();
  const SESSION_HOURS = 8; // session lasts 8 hours (1 shift)

  await db.execute({
    sql: "INSERT INTO sessions (token, user_id, username, role, display_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [token, Number(user.id), String(user.username), String(user.role), String(user.display_name), Date.now() + SESSION_HOURS * 60 * 60 * 1000],
  });

  await cleanSessions();

  return json({
    token,
    user: {
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      isAdmin: Boolean(user.is_admin),
    },
  });
}

// POST /api/generate — proxy to OpenRouter (API Key hidden server-side)
async function handleGenerate(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "กรุณา login ก่อน" }, 401);

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return json({ error: "ระบบยังไม่ได้ตั้งค่า API Key" }, 500);

  const model = Deno.env.get("OPENROUTER_MODEL") || "meta-llama/llama-3.1-8b-instruct:free";

  const { systemPrompt, userMessage, pattern, monkMode } = await req.json();

  // Log usage
  await db.execute({
    sql: "INSERT INTO usage_log (user_id, action, pattern, monk_mode) VALUES (?, 'generate', ?, ?)",
    args: [session.userId, pattern || "unknown", monkMode ? 1 : 0],
  });

  // Proxy to OpenRouter
  try {
    const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": Deno.env.get("APP_URL") || "https://lab-interpreter.deno.dev",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    const data = await orResponse.json();

    if (data.error) {
      return json({ error: data.error.message || "OpenRouter error" }, 502);
    }

    const content = data.choices?.[0]?.message?.content || "ไม่ได้รับผลลัพธ์";
    return json({ result: content, model });
  } catch (err) {
    return json({ error: `เชื่อมต่อ OpenRouter ไม่ได้: ${err}` }, 502);
  }
}

// POST /api/admin/users — manage users (admin only)
async function handleAdminUsers(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "กรุณา login ก่อน" }, 401);

  // Check admin
  const adminCheck = await db.execute({
    sql: "SELECT is_admin FROM users WHERE id = ?",
    args: [session.userId],
  });
  if (!adminCheck.rows[0]?.is_admin) {
    return json({ error: "ไม่มีสิทธิ์ admin" }, 403);
  }

  const { action, username, pin, role, displayName, userId } = await req.json();

  if (action === "list") {
    const users = await db.execute("SELECT id, username, role, display_name, is_admin, created_at FROM users ORDER BY id");
    return json({ users: users.rows });
  }

  if (action === "add") {
    if (!username || !pin || !displayName) return json({ error: "ข้อมูลไม่ครบ" }, 400);
    if (pin.length < 4) return json({ error: "PIN ต้องอย่างน้อย 4 หลัก" }, 400);
    const hash = await hashPin(pin);
    try {
      await db.execute({
        sql: "INSERT INTO users (username, pin_hash, role, display_name) VALUES (?, ?, ?, ?)",
        args: [username, hash, role || "staff", displayName],
      });
      return json({ success: true });
    } catch {
      return json({ error: "ชื่อผู้ใช้ซ้ำ" }, 400);
    }
  }

  if (action === "delete") {
    if (!userId) return json({ error: "ระบุ userId" }, 400);
    await db.execute({ sql: "DELETE FROM users WHERE id = ? AND is_admin = 0", args: [userId] });
    return json({ success: true });
  }

  if (action === "reset_pin") {
    if (!userId || !pin) return json({ error: "ระบุ userId และ PIN ใหม่" }, 400);
    const hash = await hashPin(pin);
    await db.execute({ sql: "UPDATE users SET pin_hash = ? WHERE id = ?", args: [hash, userId] });
    return json({ success: true });
  }

  return json({ error: "unknown action" }, 400);
}

// GET /api/me — check session
async function handleMe(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "not logged in" }, 401);
  return json({ user: { username: session.username, role: session.role, displayName: session.displayName } });
}

// POST /api/logout
async function handleLogout(req: Request) {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [auth.slice(7)] });
  }
  return json({ success: true });
}

// ===== Static File Serving =====
async function serveStatic(path: string): Promise<Response> {
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  const ext = path.substring(path.lastIndexOf("."));
  const contentType = mimeTypes[ext] || "application/octet-stream";

  try {
    // Try reading from ./public directory (local dev)
    const file = await Deno.readFile(`./public${path}`);
    return new Response(file, { headers: { "Content-Type": contentType } });
  } catch {
    // For Deno Deploy — embed the HTML inline or use import
    if (path === "/index.html" || path === "/") {
      const html = await Deno.readTextFile("./public/index.html");
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  }
}

// ===== Main Router =====
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // API routes
  if (url.pathname === "/api/login" && req.method === "POST") return handleLogin(req);
  if (url.pathname === "/api/logout" && req.method === "POST") return handleLogout(req);
  if (url.pathname === "/api/me" && req.method === "GET") return handleMe(req);
  if (url.pathname === "/api/generate" && req.method === "POST") return handleGenerate(req);
  if (url.pathname === "/api/admin/users" && req.method === "POST") return handleAdminUsers(req);

  // Static files
  if (url.pathname === "/" || url.pathname === "/index.html") return serveStatic("/index.html");
  if (url.pathname.includes(".")) return serveStatic(url.pathname);

  // Fallback to index
  return serveStatic("/index.html");
}

// ===== Start =====
await initDB();
console.log("🔬 Lab Interpreter running");
Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, handler);
