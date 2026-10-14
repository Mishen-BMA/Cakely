const express = require("express");
const serverless = require("serverless-http");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
const { createHash, randomBytes } = require("node:crypto");

const { validateCoupons, recordUsage } = require("./lib/couponService");

if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET_KEY || !process.env.ADMIN_PASSWORD)) {
  throw new Error("JWT_SECRET_KEY and ADMIN_PASSWORD are required in production.");
}
const SECRET_KEY = process.env.JWT_SECRET_KEY || randomBytes(32).toString("hex");
const SECURITY_MODE = (process.env.CAKELY_SECURITY_MODE || "normal").toLowerCase();
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const RULELOCK_API_URL = process.env.RULELOCK_API_URL || null;
const RULELOCK_API_TOKEN = process.env.RULELOCK_API_TOKEN || null;
const RULELOCK_TIMEOUT_MS = 8000;
const EVENT_HASH_SALT = process.env.EVENT_HASH_SALT || "";

const supabase = (process.env.NODE_ENV === "test" && global.__CAKELY_SUPABASE_CLIENT__) || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
app.set("trust proxy", 1);

// Strip the Netlify function path prefix so routes below can be defined
// exactly like the original Flask `/api/...` routes, minus the `/api`.
app.use((req, _res, next) => {
  req.url = req.url.replace(/^(\/\.netlify\/functions\/api|\/api)/, "") || "/";
  next();
});

// CORS compares origins, not full URLs. Normalising also makes a value such as
// `https://account.github.io/project-name/` work when supplied from a dashboard.
const frontendOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      return origin.replace(/\/+$/, "");
    }
  });
app.use(
  cors({
    origin: frontendOrigins.length ? frontendOrigins : true,
    credentials: frontendOrigins.length > 0,
  })
);
app.use(express.json());

// ---------- one-time-per-cold-start admin bootstrap ----------
let adminEnsured = false;
async function ensureAdmin() {
  if (adminEnsured) return;
  adminEnsured = true;
  try {
    if (!isValidUsername(ADMIN_USERNAME)) throw new Error("ADMIN_USERNAME has an invalid format.");
    const email = `${ADMIN_USERNAME}@cakely.lk`;
    const [{ data: byUsername }, { data: byEmail }] = await Promise.all([
      supabase.from("users").select("*").eq("username", ADMIN_USERNAME).maybeSingle(),
      supabase.from("users").select("*").eq("email", email).maybeSingle(),
    ]);
    if (byUsername && byEmail && byUsername.id !== byEmail.id) throw new Error("Configured admin username and email belong to different accounts.");
    const existing = byUsername || byEmail;
    if (existing) {
      if (!existing.is_admin) throw new Error("Configured admin identity belongs to a non-admin account.");
      if (process.env.ADMIN_RESET_PASSWORD === "true") {
        if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is required to reset the admin password.");
        const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        const { error } = await supabase.from("users").update({ password_hash: passwordHash }).eq("id", existing.id);
        if (error) throw error;
      }
      return;
    }
    if (!ADMIN_PASSWORD) {
      console.error("Admin bootstrap skipped because ADMIN_PASSWORD is not configured.");
      return;
    }
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const { error } = await supabase.from("users").insert({ username: ADMIN_USERNAME, email, is_admin: true, password_hash: passwordHash });
    if (error) throw error;
  } catch (err) {
    console.error("ensureAdmin failed:", err.message);
  }
}

// ---------- helpers ----------
function isValidUsername(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{2,79}$/.test(value);
}

function isValidEmail(value) {
  return typeof value === "string" && value.length <= 160 && /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);
}

function allowedPaymentMethods(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((method) => !["CARD", "COD"].includes(method))) return null;
  return [...new Set(value)];
}

function tokenFor(user, role, expiresIn = "2d") {
  return jwt.sign({ sub: String(user.id), role }, SECRET_KEY, { algorithm: "HS256", expiresIn });
}

async function currentUser(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return { user: null, error: null };
  try {
    const claims = jwt.verify(header.slice(7), SECRET_KEY, { algorithms: ["HS256"] });
    const { data } = await supabase.from("users").select("*").eq("id", Number(claims.sub)).maybeSingle();
    const expectedRole = data?.is_admin ? "admin" : "customer";
    if (!data || claims.role !== expectedRole) return { user: null, error: { code: "INVALID_TOKEN", message: "Your session is invalid. Please sign in again." } };
    return { user: data || null, error: null };
  } catch (err) {
    if (err.name === "TokenExpiredError") return { user: null, error: { code: "TOKEN_EXPIRED", message: "Your session has expired. Please log in again." } };
    return { user: null, error: { code: "INVALID_TOKEN", message: "Your session is invalid. Please log in again." } };
  }
}

function authErrorResponse(res, error, defaultMessage = "Please sign in.") {
  if (error) return res.status(401).json({ success: false, error });
  return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: defaultMessage } });
}

async function requireAdmin(req, res) {
  const { user, error } = await currentUser(req);
  if (!user || !user.is_admin) {
    res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Administrator access required." } });
    return null;
  }
  return user;
}

function requestEventContext(req, user = null, address = null) {
  const phone = address?.phone || address?.recipientPhone || "";
  const addressValue = [address?.address, address?.city, address?.district, address?.postalCode || address?.postal_code]
    .filter(Boolean).join(" ").trim().replace(/\s+/g, " ").toLowerCase();
  const hash = (value) => value ? createHash("sha256").update(`${value.trim().replace(/\s+/g, " ").toLowerCase()}${EVENT_HASH_SALT}`).digest("hex") : null;
  const normalizedPhone = String(phone).replace(/\D/g, "");
  return {
    session_id: req.headers["x-session-id"] || null,
    device_id: req.headers["x-device-id"] || null,
    account_id: user ? String(user.id) : null,
    phone_hash: hash(normalizedPhone),
    address_hash: hash(addressValue),
  };
}

async function record(eventType, metadata = {}, userId = null, orderId = null, sessionId = null, context = {}) {
  const eventId = `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const stripRawContactFields = (value) => {
    if (Array.isArray(value)) return value.map(stripRawContactFields);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(phone|address|postal_?code|raw_phone|raw_address)$/i.test(key))
      .map(([key, child]) => [key, stripRawContactFields(child)]));
  };
  const eventMetadata = stripRawContactFields({ session_id: sessionId, device_id: null, account_id: userId == null ? null : String(userId), phone_hash: null, address_hash: null, ...context, ...metadata });
  return supabase.from("transaction_events").insert({ event_id: eventId, event_type: eventType, metadata: eventMetadata, user_id: userId, order_id: orderId });
}

async function isRulelockEnabled() {
  const { data, error } = await supabase.from("platform_settings").select("rulelock_enabled").eq("id", 1).maybeSingle();
  if (error) throw error;
  return data?.rulelock_enabled === true;
}

function validRulelockResponse(value, expectedOrderId) {
  const pipeline = value?.pipeline;
  const hasPipeline = pipeline && typeof pipeline === "object" && !Array.isArray(pipeline)
    && pipeline.c1_data_collection && pipeline.c2_rule_engine && pipeline.c3_anomaly && pipeline.c4_enforcement
    && typeof pipeline.c2_rule_engine.status === "string" && Array.isArray(pipeline.c2_rule_engine.checks) && Array.isArray(pipeline.c2_rule_engine.violations)
    && typeof pipeline.c3_anomaly.status === "string" && Number.isFinite(Number(pipeline.c3_anomaly.score))
    && typeof pipeline.c4_enforcement.decision === "string";
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Number(value.order_id) === Number(expectedOrderId)
    && ["accept", "hold", "reject", "void_discount"].includes(value.decision)
    && typeof value.payment_action === "string"
    && typeof value.reason === "string"
    && typeof value.customer_message === "string"
    && (value.account_action === null || (value.account_action && value.account_action.type === "rate_limit" && Number.isFinite(Number(value.account_action.minutes)) && Number(value.account_action.minutes) > 0))
    && [value.rule_result, value.anomaly_result, value.enforcement_result].every((result) => result === null || (typeof result === "object" && !Array.isArray(result)))
    && hasPipeline);
}

async function reviewWithRuleLock({ orderId, orderReference, accountId, userId, customerName, sessionId, deviceId, phoneHash, addressHash, coupons, discount, items, subtotal, total, paymentMethod, accountVerified, pastOrders, pastRefusals }) {
  if (typeof orderReference !== "string" || !orderReference.trim()) throw new Error("RuleLock order_reference is required.");
  if (!RULELOCK_API_URL) {
    console.error("RuleLock is enabled but RULELOCK_API_URL is missing");
    return { decision: "hold", customer_message: "Your order is under review. We will update you soon.", reason: "RuleLock URL missing" };
  }
  if (!RULELOCK_API_TOKEN) {
    console.error("RuleLock is enabled but RULELOCK_API_TOKEN is missing");
    return { decision: "hold", customer_message: "Your order is under review. We will update you soon.", reason: "RuleLock token missing" };
  }
  const baseUrl = RULELOCK_API_URL.replace(/\/+$/, "").replace(/\/review-order$/i, "").replace(/\/+$/, "");
  const url = `${baseUrl}/review-order`;
  const body = {
    order_id: orderId,
    order_reference: orderReference,
    account_id: accountId,
    user_id: userId,
    customer_name: customerName,
    session_id: sessionId,
    device_id: deviceId,
    phone_hash: phoneHash,
    address_hash: addressHash,
    payment_method: paymentMethod,
    items: items.map((item) => ({ sku: `sku-${item.productId}`, name: item.name, size: item.size, quantity: item.quantity, unit_price: item.unitPrice })),
    coupons_applied: coupons,
    discount_value: discount,
    subtotal,
    total,
    account_verified: accountVerified,
    past_orders: pastOrders,
    past_refusals: pastRefusals,
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RULELOCK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RULELOCK_API_TOKEN || ""}`, "X-Session-ID": sessionId || "" },
        body: JSON.stringify(body),
      });
      if (response.status !== 200) throw new Error(`RuleLock responded ${response.status}`);
      const result = await response.json();
      if (!validRulelockResponse(result, orderId)) throw new Error("RuleLock returned an invalid response");
      return result;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  console.error("RuleLock review failed:", lastError?.message || "Unknown error");
  return { decision: "hold", customer_message: "Your order is under review. We will update you soon.", reason: "RuleLock unavailable or invalid response" };
}

async function codHistory(userId, excludeOrderId = null) {
  let query = supabase.from("orders").select("status,cancelled_by").eq("user_id", userId).eq("payment_method", "COD");
  if (excludeOrderId) query = query.neq("id", excludeOrderId);
  const { data } = await query;
  const rows = data || [];
  return {
    pastOrders: rows.length,
    pastRefusals: rows.filter((row) => row.status === "REFUSED" || (row.status === "CANCELLED" && row.cancelled_by === "CUSTOMER")).length,
  };
}

function productAsDict(row) {
  const image = typeof row.image === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(row.image)
    ? `/api/products/${encodeURIComponent(row.slug)}/image`
    : row.image;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    category: row.category,
    basePrice: Number(row.base_price),
    image,
    flavours: row.flavours,
    sizes: row.sizes,
    active: row.active,
  };
}

const CAKE_SIZES = ["1 kg", "2 kg", "3 kg", "5 kg", "7 kg", "10 kg"];

function priceForSize(product, size) {
  const configuredPrice = Number(product.sizes?.[size]);
  if (Number.isFinite(configuredPrice) && configuredPrice > 0) return configuredPrice;

  const kilograms = Number(String(size).replace(/[^\d.]/g, ""));
  const basePrice = Number(product.base_price);
  if (!CAKE_SIZES.includes(size) || !Number.isFinite(kilograms) || kilograms <= 0 || !Number.isFinite(basePrice) || basePrice <= 0) return null;
  return Math.round(basePrice * kilograms);
}

// naive in-memory rate limiter (per warm function instance only — see README)
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function loginRateLimitKey(req) {
  const identifier = String(req.body?.identifier || req.body?.email || req.body?.username || "").trim().toLowerCase().slice(0, 160);
  return `${clientIp(req)}:${identifier || "<missing>"}`;
}

function rateLimit(maxHits, windowMs, keyForRequest = clientIp) {
  const hits = new Map();
  return (req, res, next) => {
    const key = keyForRequest(req);
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > maxHits) {
      return res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests, please slow down." } });
    }
    next();
  };
}

app.use(async (req, _res, next) => {
  await ensureAdmin();
  next();
});

// ---------- routes ----------
app.get("/health", async (_req, res) => {
  const { error } = await supabase.from("products").select("id", { count: "exact", head: true });
  if (error) {
    return res.status(503).json({
      success: false,
      service: "cakely-api",
      database: "unavailable",
      error: { code: "DATABASE_UNAVAILABLE", message: "Database connection is not ready." },
    });
  }
  res.json({ success: true, service: "cakely-api", database: "connected" });
});

app.get("/rulelock/warm", (_req, res) => {
  if (RULELOCK_API_URL) {
    const healthUrl = `${RULELOCK_API_URL.replace(/\/+$/, "")}/health`;
    fetch(healthUrl, { method: "GET", signal: AbortSignal.timeout(8000) }).catch((err) => {
      console.error("RuleLock warm-up ping failed:", err.message);
    });
  }
  res.status(202).json({ success: true });
});

app.get("/products", async (req, res) => {
  let query = supabase.from("products").select("*").eq("active", true).order("id");
  const { category, search } = req.query;
  if (category && category !== "All cakes") query = query.eq("category", category);
  if (search) query = query.ilike("name", `%${search}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  res.json({ success: true, data: data.map(productAsDict) });
});

app.get("/products/:slug", async (req, res) => {
  const { data } = await supabase.from("products").select("*").eq("slug", req.params.slug).eq("active", true).maybeSingle();
  if (!data) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Product not found." } });
  res.json({ success: true, data: productAsDict(data) });
});

app.get("/products/:slug/image", async (req, res) => {
  const { data: product, error } = await supabase.from("products").select("image").eq("slug", req.params.slug).eq("active", true).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(product?.image || "");
  if (!match) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Product image not found." } });
  const image = Buffer.from(match[2], "base64");
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.type(match[1]).send(image);
});

app.get("/coupons", async (_req, res) => {
  const { data, error } = await supabase.from("coupons").select("*").eq("active", true).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  res.json({
    success: true,
    securityMode: SECURITY_MODE,
    data: (data || []).map((row) => ({
      code: row.code,
      description: row.description,
      discountType: row.discount_type || (row.value ? "PERCENTAGE" : "FIXED"),
      discountValue: Number(row.discount_value ?? row.value ?? 0),
      minimumOrder: Number(row.minimum_order ?? row.min_spend ?? 0),
      freeDelivery: row.free_delivery === true,
      canStack: !!row.can_stack,
      codApplicable: row.cod_applicable !== false,
      allowedPaymentMethods: Array.isArray(row.allowed_payment_methods) && row.allowed_payment_methods.length > 0
        ? row.allowed_payment_methods
        : ["CARD", "COD"],
      firstOrderOnly: row.first_order_only === true,
    })),
  });
});

app.post("/auth/register", rateLimit(5, 60_000), async (req, res) => {
  const data = req.body || {};
  const username = String(data.username || "").trim();
  const email = String(data.email || "").trim().toLowerCase();
  if (!isValidUsername(username) || !isValidEmail(email) || !data.password || String(data.password).length < 8) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Use a valid username, email, and password of at least 8 characters." } });
  }
  const [{ data: existingEmail }, { data: existingUsername }] = await Promise.all([
    supabase.from("users").select("id").eq("email", email).maybeSingle(),
    supabase.from("users").select("id").eq("username", username).maybeSingle(),
  ]);
  if (existingEmail || existingUsername) return res.status(409).json({ success: false, error: { code: "USER_EXISTS", message: "That account already exists." } });
  const passwordHash = await bcrypt.hash(data.password, 10);
  const { data: user, error } = await supabase.from("users").insert({ username, email, password_hash: passwordHash }).select().single();
  if (error?.code === "23505") return res.status(409).json({ success: false, error: { code: "USER_EXISTS", message: "That username or email is already registered." } });
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("REGISTER", { email: user.email }, user.id, null, req.headers["x-session-id"] || null, requestEventContext(req, user));
  res.status(201).json({ success: true, data: { token: tokenFor(user, "customer"), user: { username: user.username, isAdmin: false } } });
});

app.post("/auth/login", rateLimit(10, 60_000, loginRateLimitKey), async (req, res) => {
  const data = req.body || {};
  const identifier = String(data.identifier || data.email || data.username || "").trim();
  const emailLogin = identifier.includes("@");
  if (emailLogin ? !isValidEmail(identifier) : !isValidUsername(identifier)) {
    return res.status(400).json({ success: false, error: { code: "INVALID_IDENTIFIER", message: "Enter a valid email or username." } });
  }
  const { data: user } = await supabase.from("users").select("*").eq(emailLogin ? "email" : "username", emailLogin ? identifier.toLowerCase() : identifier).maybeSingle();
  if (!user || !(await bcrypt.compare(data.password || "", user.password_hash))) {
    return res.status(401).json({ success: false, error: { code: "INVALID_LOGIN", message: "Username/email or password is incorrect." } });
  }
  if (user.is_admin) return res.status(403).json({ success: false, error: { code: "ADMIN_LOGIN_REQUIRED", message: "Administrators must use the administrator sign-in page." } });
  await record("LOGIN", { role: user.is_admin ? "admin" : "customer" }, user.id, null, req.headers["x-session-id"] || null, requestEventContext(req, user));
  res.json({ success: true, data: { token: tokenFor(user, "customer"), user: { username: user.username, isAdmin: false } } });
});

app.post("/auth/admin-login", rateLimit(10, 60_000, loginRateLimitKey), async (req, res) => {
  const data = req.body || {};
  const identifier = String(data.identifier || data.email || data.username || "").trim();
  const emailLogin = identifier.includes("@");
  if (emailLogin ? !isValidEmail(identifier) : !isValidUsername(identifier)) {
    return res.status(400).json({ success: false, error: { code: "INVALID_IDENTIFIER", message: "Enter a valid email or username." } });
  }
  const { data: user } = await supabase.from("users").select("*").eq(emailLogin ? "email" : "username", emailLogin ? identifier.toLowerCase() : identifier).maybeSingle();
  if (!user || !user.is_admin || !(await bcrypt.compare(data.password || "", user.password_hash))) {
    return res.status(401).json({ success: false, error: { code: "INVALID_LOGIN", message: "Administrator username/email or password is incorrect." } });
  }
  await record("LOGIN", { role: "admin" }, user.id, null, req.headers["x-session-id"] || null, requestEventContext(req, user));
  res.json({ success: true, data: { token: tokenFor(user, "admin", "8h"), user: { username: user.username, isAdmin: true } } });
});

app.get("/auth/me", async (req, res) => {
  const { user, error } = await currentUser(req);
  if (!user) return authErrorResponse(res, error);
  res.json({ success: true, data: { username: user.username, email: user.email, isAdmin: user.is_admin } });
});

app.get("/addresses", async (req, res) => {
  const { user } = await currentUser(req);
  if (!user) return authErrorResponse(res);
  const { data, error } = await supabase.from("addresses").select("*").eq("user_id", user.id).order("is_default", { ascending: false }).order("created_at", { ascending: false });
  if (error && /addresses|schema cache/i.test(error.message || "")) return res.json({ success: true, data: [] });
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  res.json({ success: true, data: data || [] });
});

app.post("/addresses", async (req, res) => {
  const { user } = await currentUser(req);
  if (!user) return authErrorResponse(res);
  const data = req.body || {};
  if (!data.recipient || !data.phone || !data.address || !data.city || !data.district) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Recipient, phone, address, city, and district are required." } });
  if (data.isDefault) await supabase.from("addresses").update({ is_default: false }).eq("user_id", user.id);
  const { data: row, error } = await supabase.from("addresses").insert({ user_id: user.id, label: data.label || "Home", recipient: data.recipient, phone: data.phone, address: data.address, city: data.city, district: data.district, postal_code: data.postalCode || null, is_default: !!data.isDefault }).select().single();
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  res.status(201).json({ success: true, data: row });
});

app.delete("/addresses/:id", async (req, res) => {
  const { user } = await currentUser(req);
  if (!user) return authErrorResponse(res);
  const { error } = await supabase.from("addresses").delete().eq("id", Number(req.params.id)).eq("user_id", user.id);
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  res.json({ success: true });
});

app.post("/checkout", async (req, res) => {
  const { user } = await currentUser(req);
  const data = req.body || {};
  const items = data.items || [];
  const sessionId = req.headers["x-session-id"] || null;
  const eventContext = requestEventContext(req, user, data.address || null);
  const fulfillmentMethod = data.fulfillmentMethod === "PICKUP" ? "PICKUP" : "DELIVERY";
  await record("CHECKOUT", { ...eventContext, attempt: true }, user?.id || null, null, sessionId);
  if (!user || user.is_admin) {
    return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Please sign in before adding items or placing an order." } });
  }
  if (user.rate_limited_until && new Date(user.rate_limited_until).getTime() > Date.now()) {
    return res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Checkout is temporarily unavailable for this account." } });
  }
  if (!items.length || (fulfillmentMethod === "DELIVERY" && !data.address) || !["COD", "CARD"].includes(data.paymentMethod)) {
    return res.status(400).json({ success: false, error: { code: "CHECKOUT_INVALID", message: "Complete your cart, address, and payment method." } });
  }

  let rulelockOn = false;
  try { rulelockOn = await isRulelockEnabled(); } catch (err) {
    console.error("Unable to read RuleLock setting:", err.message);
    rulelockOn = true;
  }

  let subtotal = 0;
  const verifiedItems = [];
  for (const entry of items) {
    const { data: item } = await supabase.from("products").select("*").eq("id", entry.productId).maybeSingle();
    const quantity = (SECURITY_MODE === "research" || rulelockOn)
      ? Math.max(1, Number(entry.quantity || 1))
      : Math.max(1, Math.min(Number(entry.quantity || 1), 20));
    if (!item || !item.active) {
      return res.status(400).json({ success: false, error: { code: "PRODUCT_UNAVAILABLE", message: "A selected cake is unavailable." } });
    }
    const size = entry.size || "1 kg";
    const price = priceForSize(item, size);
    if (price == null) {
      return res.status(400).json({ success: false, error: { code: "SIZE_UNAVAILABLE", message: "Choose an available cake size." } });
    }
    const flavour = entry.flavour ?? item.flavours?.[0];
    if (!Array.isArray(item.flavours) || !item.flavours.includes(flavour)) {
      return res.status(400).json({ success: false, error: { code: "FLAVOUR_UNAVAILABLE", message: "Choose an available cake flavour." } });
    }
    subtotal += price * quantity;
    verifiedItems.push({ productId: item.id, name: item.name, size, flavour, quantity, unitPrice: price });
  }

  const couponResult = await validateCoupons({ codes: data.coupons || [], subtotal, user, paymentMethod: data.paymentMethod, securityMode: SECURITY_MODE, supabase });
  for (const code of data.coupons || []) {
    await record("APPLY_COUPON", { ...eventContext, coupon_code: String(code) }, user.id, null, sessionId);
  }
  const submittedDiscount = Number(data.discount || 0);
  if (submittedDiscount !== couponResult.discount) {
    await record("DISCOUNT_MANIPULATION_ATTEMPT", { coupons: data.coupons || [], expectedDiscount: couponResult.discount, submittedDiscount }, user.id, null, sessionId, eventContext);
  }
  if ((data.coupons || []).length > 1) {
    await record("COUPON_STACK_ATTEMPT", { coupons: data.coupons, accepted: couponResult.accepted, rejected: couponResult.rejected }, user.id, null, sessionId, eventContext);
  }
  for (const rejected of couponResult.rejected) {
    if (/limit|expired/i.test(rejected.reason)) await record("COUPON_LIMIT_EXCEEDED", { coupon_code: rejected.code, reason: rejected.reason }, user.id, null, sessionId, eventContext);
  }

  let discount = couponResult.discount;
  let appliedCoupons = couponResult.accepted.map((coupon) => coupon.code);
  let freeDelivery = couponResult.freeDelivery;
  let delivery = fulfillmentMethod === "PICKUP" || freeDelivery ? 0 : 350;
  const codFee = data.paymentMethod === "COD" && fulfillmentMethod === "DELIVERY" ? 150 : 0;
  let total = subtotal - discount + delivery + codFee;
  const address = fulfillmentMethod === "PICKUP"
    ? { fulfillmentMethod, label: "Self pickup", recipient: data.address?.name || "Customer", phone: data.address?.phone || "", pickupLocation: "Cakely Colombo" }
    : { ...data.address, fulfillmentMethod };

  const orderNumber = () => {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const suffix = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    return `CK-${timestamp}-${suffix}`;
  };
  let order;
  let error;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await supabase.from("orders").insert({
      order_number: orderNumber(),
      user_id: user.id,
      items: verifiedItems,
      address,
      payment_method: data.paymentMethod,
      payment_status: "PENDING",
      status: "PENDING",
      subtotal,
      discount,
      delivery_fee: delivery + codFee,
      total,
    }).select().single();
    order = inserted.data;
    error = inserted.error;
    if (!error || error.code !== "23505" || attempt === 1) break;
  }
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });

  let rulelockResult = { decision: "accept", customer_message: "Your order is confirmed." };
  if (rulelockOn) {
    const { pastOrders, pastRefusals } = data.paymentMethod === "COD"
      ? await codHistory(user.id, order.id)
      : { pastOrders: 0, pastRefusals: 0 };
    const { data: completedOrders } = await supabase.from("orders").select("id").eq("user_id", user.id).eq("status", "COMPLETED").limit(1);
    const hashes = requestEventContext(req, user, address);

    rulelockResult = await reviewWithRuleLock({
      orderId: order.id,
      orderReference: order.order_number,
      sessionId,
      deviceId: hashes.device_id,
      phoneHash: hashes.phone_hash,
      addressHash: hashes.address_hash,
      accountId: String(user.id),
      userId: user.id,
      customerName: address.recipient || address.name || user.username,
      coupons: (data.coupons || []).length > appliedCoupons.length ? data.coupons : appliedCoupons,
      discount: Math.max(discount, submittedDiscount),
      items: verifiedItems,
      subtotal,
      total,
      paymentMethod: data.paymentMethod,
      accountVerified: Boolean(completedOrders?.length),
      pastOrders,
      pastRefusals,
    });
  }

  if (rulelockOn && rulelockResult.account_action?.type === "rate_limit") {
    const until = new Date(Date.now() + Number(rulelockResult.account_action.minutes) * 60_000).toISOString();
    const { error: limitError } = await supabase.from("users").update({ rate_limited_until: until }).eq("id", user.id);
    if (limitError) {
      console.error("Unable to persist RuleLock rate limit:", limitError.message);
      rulelockResult = { ...rulelockResult, decision: "hold", customer_message: "Your order is under review. We will update you soon." };
    }
  }

  const voidDiscount = rulelockResult.decision === "void_discount";
  const originalDecision = rulelockResult.decision;
  if (voidDiscount) {
    discount = 0;
    appliedCoupons = [];
    freeDelivery = false;
    delivery = fulfillmentMethod === "PICKUP" ? 0 : 350;
    total = subtotal + delivery + codFee;
    rulelockResult = { ...rulelockResult, decision: "accept" };
  }
  const decision = rulelockResult.decision;
  const finalStatus = decision === "reject" ? "REJECTED" : decision === "hold" ? "PENDING_REVIEW" : "PENDING";
  const paymentStatus = decision === "reject" ? "VOIDED" : decision === "hold" ? "ON_HOLD" : data.paymentMethod === "CARD" ? "PAID" : "PENDING";
  if ((decision === "accept" && !voidDiscount) || decision === "hold") {
    const { error: usageError } = await recordUsage({ result: couponResult, userId: user.id, orderId: order.id, supabase });
    if (usageError) {
      const { error: cleanupError } = await supabase.from("orders").delete().eq("id", order.id);
      if (cleanupError) console.error("Unable to remove order after coupon reservation failed:", cleanupError.message);
      console.error("Unable to reserve coupon usage:", usageError.message);
      return res.status(503).json({ success: false, error: { code: "COUPON_USAGE_UNAVAILABLE", message: "Coupon availability could not be confirmed. Please retry checkout." } });
    }
  }
  const review = rulelockOn ? {
    decision: originalDecision,
    reason: rulelockResult.reason || null,
    customer_message: rulelockResult.customer_message || null,
    pipeline: rulelockResult.pipeline || null,
    reviewed_at: new Date().toISOString(),
    ...(rulelockResult.error ? { error: rulelockResult.error } : {}),
  } : null;
  if (rulelockOn && (!rulelockResult.pipeline || String(rulelockResult.reason || "").toLowerCase().includes("unavailable"))) review.error = "RuleLock unavailable";
  const { data: updatedOrder, error: updateError } = await supabase.from("orders").update({ status: finalStatus, payment_status: paymentStatus, discount, delivery_fee: delivery + codFee, total, rulelock_review: review }).eq("id", order.id).select().single();
  if (updateError) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: updateError.message } });
  order = updatedOrder;

  if (rulelockOn) await record("RULELOCK_DECISION_APPLIED", { ...eventContext, order_id: order.id, decision, resulting_status: finalStatus }, user.id, order.id, sessionId);

  if (decision === "reject") return res.status(201).json({ success: true, data: { id: order.id, orderNumber: order.order_number, total, status: "REJECTED", decision: originalDecision, customerMessage: rulelockResult.customer_message, review } });
  res.status(201).json({ success: true, data: { id: order.id, orderNumber: order.order_number, total, status: order.status, decision: originalDecision, customerMessage: rulelockResult.customer_message, review } });
});

app.get("/orders", async (req, res) => {
  const { user } = await currentUser(req);
  if (!user) return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Please sign in to view orders." } });
  const { data, error } = await supabase.from("orders").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  res.json({
    success: true,
    data: (data || []).map((row) => ({ id: row.id, orderNumber: row.order_number, items: row.items, subtotal: Number(row.subtotal), discount: Number(row.discount), deliveryFee: Number(row.delivery_fee), total: Number(row.total), status: row.status, paymentMethod: row.payment_method, fulfillmentMethod: row.address?.fulfillmentMethod || "DELIVERY", rulelockReview: row.rulelock_review || null, createdAt: row.created_at })),
  });
});

app.post("/orders/:id/cancel", async (req, res) => {
  const { user } = await currentUser(req);
  if (!user || user.is_admin) return authErrorResponse(res);
  const orderId = Number(req.params.id);
  if (!Number.isSafeInteger(orderId) || orderId < 1) return res.status(400).json({ success: false, error: { code: "INVALID_ORDER", message: "Order id is invalid." } });
  const { data: existing } = await supabase.from("orders").select("*").eq("id", orderId).eq("user_id", user.id).maybeSingle();
  if (!existing) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Order not found." } });
  if (!["PENDING", "PENDING_REVIEW"].includes(existing.status)) return res.status(400).json({ success: false, error: { code: "INVALID_ORDER_ACTION", message: "Only pending orders can be cancelled." } });
  const { data: updated, error } = await supabase.from("orders").update({ status: "CANCELLED", cancelled_by: "CUSTOMER" }).eq("id", orderId).eq("user_id", user.id).in("status", ["PENDING", "PENDING_REVIEW"]).select().maybeSingle();
  if (error || !updated) return res.status(400).json({ success: false, error: { code: "INVALID_ORDER_ACTION", message: "Order could not be cancelled." } });
  await record("ORDER_CANCELLED", { status: "CANCELLED", cancelled_by: "CUSTOMER" }, user.id, orderId, req.headers["x-session-id"] || null, requestEventContext(req, user));
  res.json({ success: true, data: { id: updated.id, status: updated.status } });
});

app.get("/admin/summary", async (req, res) => {
  const { user } = await currentUser(req);
  if (!user || !user.is_admin) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Administrator access required." } });
  const { data: orders } = await supabase.from("orders").select("total,status");
  const { count: events } = await supabase.from("transaction_events").select("id", { count: "exact", head: true });
  res.json({
    success: true,
    data: {
      orders: (orders || []).length,
      pending: (orders || []).filter((o) => o.status === "PENDING").length,
      revenue: (orders || []).reduce((sum, o) => sum + Number(o.total), 0),
      events: events || 0,
    },
  });
});

const DASHBOARD_PAGE_SIZE = 20;
function dashboardPage(value) {
  const page = Number(value || 1);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1;
}

app.get("/admin/dashboard", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const pages = {
    orders: dashboardPage(req.query.ordersPage),
    customers: dashboardPage(req.query.customersPage),
    events: dashboardPage(req.query.eventsPage),
  };
  const range = (page) => [(page - 1) * DASHBOARD_PAGE_SIZE, page * DASHBOARD_PAGE_SIZE - 1];
  const recentOrdersRequest = pages.orders === 1
    ? Promise.resolve(null)
    : supabase.from("orders").select("*").order("created_at", { ascending: false }).range(0, 5);
  const [ordersResult, customersResult, eventsResult, { data: coupons }, { data: products }, { data: platformSettings }, { data: metricsRows, error: metricsError }, recentOrdersResult] = await Promise.all([
    supabase.from("orders").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(...range(pages.orders)),
    supabase.from("users").select("*", { count: "exact" }).eq("is_admin", false).order("created_at", { ascending: false }).range(...range(pages.customers)),
    supabase.from("transaction_events").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(...range(pages.events)),
    supabase.from("coupons").select("*").order("created_at", { ascending: false }),
    supabase.from("products").select("*").order("id"),
    supabase.from("platform_settings").select("rulelock_enabled").eq("id", 1).maybeSingle(),
    supabase.rpc("admin_dashboard_metrics"),
    recentOrdersRequest,
  ]);
  if (metricsError) return res.status(500).json({ success: false, error: { code: "DASHBOARD_METRICS_UNAVAILABLE", message: "Dashboard metrics are unavailable. Apply the latest Supabase migration." } });
  const allOrders = ordersResult.data || [];
  const recentOrderRows = pages.orders === 1 ? allOrders.slice(0, 6) : recentOrdersResult?.data || [];
  const customers = customersResult.data || [];
  const events = eventsResult.data || [];
  const orderCustomerIds = [...new Set([...allOrders, ...recentOrderRows].map((order) => order.user_id).filter((id) => id != null))];
  const orderCustomersResult = orderCustomerIds.length
    ? await supabase.from("users").select("id,username,email").in("id", orderCustomerIds)
    : { data: [], error: null };
  if (orderCustomersResult.error) return res.status(500).json({ success: false, error: { code: "DASHBOARD_CUSTOMERS_UNAVAILABLE", message: "Order customer details are unavailable." } });
  const customerStatsResult = customers.length
    ? await supabase.rpc("admin_dashboard_customer_stats", { p_user_ids: customers.map((customer) => customer.id) })
    : { data: [], error: null };
  if (customerStatsResult.error) return res.status(500).json({ success: false, error: { code: "DASHBOARD_METRICS_UNAVAILABLE", message: "Customer order totals are unavailable. Apply the latest Supabase migration." } });
  const statsByUser = new Map((customerStatsResult.data || []).map((row) => [String(row.user_id), row]));

  const orderCustomerById = new Map((orderCustomersResult.data || []).map((c) => [String(c.id), c]));
  const orderDict = (row) => ({
    id: row.id,
    orderNumber: row.order_number,
    customer: orderCustomerById.get(String(row.user_id))?.username || null,
    customerEmail: orderCustomerById.get(String(row.user_id))?.email || null,
    items: row.items || [],
    address: row.address || {},
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    deliveryFee: Number(row.delivery_fee),
    total: Number(row.total),
    status: row.status,
    rulelockReview: row.rulelock_review || null,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    fulfillmentMethod: row.address?.fulfillmentMethod || "DELIVERY",
    createdAt: row.created_at,
  });
  const orderDicts = allOrders.map(orderDict);
  const recentOrderDicts = recentOrderRows.map(orderDict);

  const customerDicts = customers.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    orders: Number(statsByUser.get(String(row.id))?.orders || 0),
    spending: Number(statsByUser.get(String(row.id))?.spending || 0),
    createdAt: row.created_at,
  }));

  const couponDicts = (coupons || []).map((row) => ({ id: row.id, code: row.code, description: row.description, discountType: row.discount_type, discountValue: Number(row.discount_value), active: row.active }));
  const eventDicts = events.map((row) => ({ id: row.id, eventId: row.event_id, eventType: row.event_type, orderId: row.order_id, createdAt: row.created_at }));
  const metrics = Array.isArray(metricsRows) ? metricsRows[0] : metricsRows;
  const pageInfo = (page, total) => ({ page, pageSize: DASHBOARD_PAGE_SIZE, total: Number(total || 0), pages: Math.max(1, Math.ceil(Number(total || 0) / DASHBOARD_PAGE_SIZE)) });

  res.json({
    success: true,
    data: {
      orders: Number(metrics?.order_count || 0),
      pending: Number(metrics?.pending_count || 0),
      preparing: Number(metrics?.preparing_count || 0),
      completed: Number(metrics?.completed_count || 0),
      customerCount: Number(metrics?.customer_count || 0),
      productCount: (products || []).length,
      couponCount: (coupons || []).filter((c) => c.active).length,
      revenue: Number(metrics?.revenue || 0),
      recentOrders: recentOrderDicts,
      allOrders: orderDicts,
      customers: customerDicts,
      products: (products || []).map(productAsDict),
      coupons: couponDicts,
      events: eventDicts,
      rulelockEnabled: platformSettings?.rulelock_enabled === true,
      rulelockConfigured: Boolean(RULELOCK_API_URL),
      securityMode: SECURITY_MODE,
      pagination: {
        orders: pageInfo(pages.orders, ordersResult.count),
        customers: pageInfo(pages.customers, customersResult.count),
        events: pageInfo(pages.events, eventsResult.count),
      },
    },
  });
});

app.patch("/admin/rulelock", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const enabled = req.body?.enabled === true;
  const { data, error } = await supabase.from("platform_settings").upsert({ id: 1, rulelock_enabled: enabled, updated_at: new Date().toISOString() }).select("rulelock_enabled").single();
  if (error) return res.status(500).json({ success: false, error: { code: "RULELOCK_SETTING_FAILED", message: `Unable to save the RuleLock setting: ${error.message}` } });
  res.json({ success: true, data: { enabled: data.rulelock_enabled } });
});

app.post("/admin/products", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const data = req.body || {};
  if (!data.name || !data.slug || !data.description || !data.category) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Name, slug, description, and category are required." } });
  }
  const { data: existing } = await supabase.from("products").select("id").eq("slug", data.slug).maybeSingle();
  if (existing) return res.status(409).json({ success: false, error: { code: "SLUG_EXISTS", message: "That product slug is already used." } });
  const basePrice = Number(data.basePrice || 0);
  const { data: row, error } = await supabase
    .from("products")
    .insert({
      name: data.name,
      slug: data.slug,
      description: data.description,
      category: data.category,
      base_price: basePrice,
      image: data.image || "",
      flavours: data.flavours || ["Vanilla"],
      sizes: data.sizes || { "1 kg": basePrice },
      active: data.active === undefined ? true : !!data.active,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("ADMIN_PRODUCT_CREATED", { productId: row.id, name: row.name }, admin.id, null, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.status(201).json({ success: true, data: productAsDict(row) });
});

app.put("/admin/products/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const productId = Number(req.params.id);
  const { data: row } = await supabase.from("products").select("*").eq("id", productId).maybeSingle();
  if (!row) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Product not found." } });
  const data = req.body || {};
  if (data.slug && data.slug !== row.slug) {
    const { data: existing } = await supabase.from("products").select("id").eq("slug", data.slug).neq("id", productId).maybeSingle();
    if (existing) return res.status(409).json({ success: false, error: { code: "SLUG_EXISTS", message: "That product slug is already used." } });
  }
  const updates = {};
  for (const [key, col] of [["name", "name"], ["slug", "slug"], ["description", "description"], ["category", "category"], ["image", "image"], ["flavours", "flavours"], ["sizes", "sizes"], ["active", "active"]]) {
    if (key in data) updates[col] = data[key];
  }
  if ("basePrice" in data) updates.base_price = Number(data.basePrice);
  const { data: updated, error } = await supabase.from("products").update(updates).eq("id", productId).select().single();
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("ADMIN_PRODUCT_UPDATED", { productId }, admin.id, null, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.json({ success: true, data: productAsDict(updated) });
});

app.post("/admin/products/:id/image", upload.single("image"), async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const productId = Number(req.params.id);
  const { data: row } = await supabase.from("products").select("*").eq("id", productId).maybeSingle();
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  const extension = String(req.file?.originalname || "").toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/)?.[1];
  const validImage = req.file && (allowedTypes.has(req.file.mimetype) || Boolean(extension));
  if (!row || !validImage) {
    return res.status(400).json({ success: false, error: { code: "INVALID_IMAGE", message: "Choose a JPG, PNG, WEBP, or GIF image." } });
  }
  if (req.file.size > 3 * 1024 * 1024) return res.status(400).json({ success: false, error: { code: "IMAGE_TOO_LARGE", message: "Choose an image smaller than 3 MB." } });
  const imageDataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
  const { data: updated, error } = await supabase.from("products").update({ image: imageDataUrl }).eq("id", productId).select().single();
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("ADMIN_PRODUCT_IMAGE_CHANGED", { productId, storage: "database", bytes: req.file.size, contentType: req.file.mimetype }, admin.id, null, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.json({ success: true, data: productAsDict(updated) });
});

app.delete("/admin/products/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const productId = Number(req.params.id);
  const { data: row, error: lookupError } = await supabase.from("products").select("id").eq("id", productId).maybeSingle();
  if (lookupError) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: lookupError.message } });
  if (!row) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Product not found." } });
  const { error } = await supabase.from("products").delete().eq("id", productId);
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("ADMIN_PRODUCT_DELETED", { productId }, admin.id, null, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.json({ success: true });
});

app.patch("/admin/orders/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const orderId = Number(req.params.id);
  const action = String(req.body?.action || "").toLowerCase();
  const status = req.body?.status;
  if (!Number.isSafeInteger(orderId) || orderId < 1) return res.status(400).json({ success: false, error: { code: "INVALID_ORDER_ACTION", message: "Order action is invalid." } });
  const { data: existing } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!existing) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Order not found." } });
  let updates;
  if (["release", "reject"].includes(action)) {
    if (existing.status !== "PENDING_REVIEW") return res.status(400).json({ success: false, error: { code: "INVALID_ORDER_ACTION", message: "Only orders under review can be released or rejected." } });
    const nextStatus = action === "release" ? "PENDING" : "REJECTED";
    updates = { status: nextStatus, payment_status: action === "reject" ? "VOIDED" : existing.payment_method === "CARD" ? "PAID" : "PENDING" };
  } else if (status === "REFUSED") {
    if (existing.payment_method !== "COD" || !["PENDING", "PREPARING", "COMPLETED"].includes(existing.status)) return res.status(400).json({ success: false, error: { code: "INVALID_ORDER_ACTION", message: "Only a COD order can be marked refused." } });
    updates = { status: "REFUSED" };
  } else if (status === "CANCELLED") {
    updates = { status: "CANCELLED", cancelled_by: "ADMIN" };
  } else if (status === "PREPARING" && existing.status === "PENDING" || status === "COMPLETED" && existing.status === "PREPARING") {
    updates = { status };
  } else {
    return res.status(400).json({ success: false, error: { code: "INVALID_ORDER_ACTION", message: "This order status change is not allowed." } });
  }
  const { data: updated, error } = await supabase.from("orders").update(updates).eq("id", orderId).select().maybeSingle();
  if (error || !updated) return res.status(400).json({ success: false, error: { code: "INVALID_ORDER", message: "Order could not be updated." } });
  if (["release", "reject"].includes(action)) await record("RULELOCK_OVERRIDE", { order_id: orderId, action, admin_id: admin.id, previous_decision: "hold" }, admin.id, orderId, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  if (status === "CANCELLED") await record("ORDER_CANCELLED", { status: "CANCELLED" }, admin.id, orderId, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  if (status === "REFUSED") await record("ORDER_REFUSED", { status: "REFUSED" }, admin.id, orderId, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.json({ success: true, data: { id: updated.id, status: updated.status } });
});

app.post("/admin/coupons", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const data = req.body || {};
  const code = String(data.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Coupon code is required." } });
  const methods = allowedPaymentMethods(data.allowedPaymentMethods);
  if (methods === null) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Allowed payment methods must contain CARD or COD." } });
  const { data: row, error } = await supabase
    .from("coupons")
    .insert({
      code,
      description: data.description || "",
      discount_type: data.discountType || "PERCENTAGE",
      discount_value: Number(data.discountValue || 0),
      minimum_order: Number(data.minimumOrder || 0),
      max_discount: data.maxDiscount != null ? Number(data.maxDiscount) : null,
      usage_limit: data.usageLimit ?? null,
      per_user_limit: data.perUserLimit ?? null,
      expires_at: data.expiresAt || null,
      can_stack: !!data.canStack,
      first_order_only: !!data.firstOrderOnly,
      allowed_payment_methods: methods,
      free_delivery: !!data.freeDelivery,
      cod_applicable: data.codApplicable === undefined ? true : !!data.codApplicable,
      active: data.active === undefined ? true : !!data.active,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("ADMIN_COUPON_CREATED", { couponId: row.id, code: row.code }, admin.id, null, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.status(201).json({ success: true, data: { id: row.id, code: row.code } });
});

app.put("/admin/coupons/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const couponId = Number(req.params.id);
  const { data: row } = await supabase.from("coupons").select("*").eq("id", couponId).maybeSingle();
  if (!row) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Coupon not found." } });
  const data = req.body || {};
  const updates = {};
  for (const [key, col] of [["description", "description"], ["discountType", "discount_type"], ["active", "active"], ["canStack", "can_stack"], ["firstOrderOnly", "first_order_only"], ["codApplicable", "cod_applicable"], ["freeDelivery", "free_delivery"]]) {
    if (key in data) updates[col] = data[key];
  }
  if ("code" in data) updates.code = String(data.code).toUpperCase();
  if ("discountValue" in data) updates.discount_value = Number(data.discountValue);
  if ("minimumOrder" in data) updates.minimum_order = Number(data.minimumOrder);
  if ("maxDiscount" in data) updates.max_discount = data.maxDiscount != null ? Number(data.maxDiscount) : null;
  if ("usageLimit" in data) updates.usage_limit = data.usageLimit;
  if ("perUserLimit" in data) updates.per_user_limit = data.perUserLimit;
  if ("expiresAt" in data) updates.expires_at = data.expiresAt;
  if ("firstOrderOnly" in data) updates.first_order_only = !!data.firstOrderOnly;
  if ("freeDelivery" in data) updates.free_delivery = !!data.freeDelivery;
  if ("allowedPaymentMethods" in data) {
    const methods = allowedPaymentMethods(data.allowedPaymentMethods);
    if (methods === null) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Allowed payment methods must contain CARD or COD." } });
    updates.allowed_payment_methods = methods;
  }
  const { error } = await supabase.from("coupons").update(updates).eq("id", couponId);
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("ADMIN_COUPON_UPDATED", { couponId }, admin.id, null, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.json({ success: true, data: { id: couponId } });
});

app.delete("/admin/coupons/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const couponId = Number(req.params.id);
  const { error } = await supabase.from("coupons").update({ active: false }).eq("id", couponId);
  if (error) return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: error.message } });
  await record("ADMIN_COUPON_DEACTIVATED", { couponId }, admin.id, null, req.headers["x-session-id"] || null, requestEventContext(req, admin));
  res.json({ success: true });
});

// The standalone Render server serves the built frontend from the same app.
// Netlify does not set SERVE_FRONTEND, so its static-site routing is unchanged.
if (process.env.SERVE_FRONTEND === "true") {
  const path = require("path");
  const frontendDirectory = path.join(process.cwd(), "frontend", "dist");
  app.use(express.static(frontendDirectory));
  app.get("*", (req, res, next) => {
    if (/^\/(api|\.netlify\/functions\/api)(\/|$)/.test(req.originalUrl)) return next();
    return res.sendFile(path.join(frontendDirectory, "index.html"));
  });
}

app.use((_req, res) => res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found." } }));

module.exports.app = app;
module.exports.handler = serverless(app, { binary: ["multipart/form-data"] });
