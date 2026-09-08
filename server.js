const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
const db = new Database("rntx.db");
const PORT = Number(process.env.PORT) || 5000;
const SESSION_SECRET = process.env.SESSION_SECRET || "CHANGE_THIS_IN_REPLIT_SECRETS";

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 7*24*60*60*1000 }
}));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reseller',
  referral_code TEXT UNIQUE,
  parent_id INTEGER,
  panel_expires_at TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT UNIQUE NOT NULL,
  game TEXT NOT NULL,
  duration TEXT NOT NULL,
  expires_at TEXT,
  max_devices INTEGER NOT NULL DEFAULT 1,
  devices_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'UNUSED',
  owner_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(key_id, device_id)
);
`);

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("keys", "price_paid", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("keys", "order_id", "TEXT");
ensureColumn("users", "max_device_limit", "INTEGER NOT NULL DEFAULT 2000");

db.exec(`
CREATE TABLE IF NOT EXISTS pricing_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duration TEXT UNIQUE NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pricing_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duration TEXT NOT NULL,
  device_limit INTEGER NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(duration, device_limit)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  reseller_id INTEGER NOT NULL,
  duration TEXT NOT NULL,
  device_limit INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  description TEXT NOT NULL,
  related_order_id TEXT,
  related_license_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  user_id INTEGER,
  username TEXT,
  ip_address TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
ensureColumn("orders", "device_limit", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("transactions", "performed_by", "INTEGER");
ensureColumn("transactions", "performed_by_username", "TEXT");

const defaultPlans = [
  ["5 Hours", 50, 1], ["12 Hours", 100, 2], ["1 Day", 150, 3],
  ["7 Days", 400, 4], ["15 Days", 700, 5], ["1 Month", 900, 6],
  ["2 Months", 1200, 7], ["Lifetime", 5000, 8]
];
const insertPlan = db.prepare("INSERT OR IGNORE INTO pricing_plans(duration,price,sort_order) VALUES(?,?,?)");
for (const plan of defaultPlans) insertPlan.run(...plan);
const tierLimits = [1, 10, 100, 500, 1000, 2000];
const tierFactors = {1:1, 10:1.25, 100:2, 500:3, 1000:4.1667, 2000:6.6667};
const insertTier = db.prepare("INSERT OR IGNORE INTO pricing_tiers(duration,device_limit,price,sort_order) VALUES(?,?,?,?)");
for (const [duration, basePrice, sortOrder] of defaultPlans) {
  const explicit = duration === "2 Months" ? {1:1200,10:1500,100:2500,1000:5000,2000:8000} : null;
  for (const deviceLimit of tierLimits) {
    const price = explicit?.[deviceLimit] ?? Math.round(basePrice * tierFactors[deviceLimit]);
    insertTier.run(duration, deviceLimit, price, sortOrder * 10 + tierLimits.indexOf(deviceLimit));
  }
}

function ensureAdmin() {
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!admin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "ChangeMe123!", 12);
    db.prepare("INSERT INTO users(username,password_hash,role,referral_code,panel_expires_at) VALUES(?,?,?,?,NULL)")
      .run(process.env.ADMIN_USERNAME || "admin", hash, "admin", "RNTXADMIN");
    console.log("Default admin created. Set ADMIN_USERNAME, ADMIN_PASSWORD and SESSION_SECRET in Replit Secrets.");
  }
}
ensureAdmin();

function auth(req,res,next) {
  if (!req.session.user) return res.status(401).json({error:"Login required"});
  const user = db.prepare("SELECT id,username,role,active,panel_expires_at,balance,max_device_limit FROM users WHERE id=?").get(req.session.user.id);
  if (!user || !user.active) return res.status(403).json({error:"Panel blocked",code:"PANEL_BLOCKED"});
  if (user.role === "reseller" && user.panel_expires_at && new Date(user.panel_expires_at) <= new Date()) {
    return res.status(403).json({error:"Reseller panel access has expired",code:"PANEL_EXPIRED"});
  }
  req.currentUser = user;
  req.session.user = {...req.session.user, ...user, max_device_limit:user.max_device_limit || 2000};
  next();
}
function adminOnly(req,res,next) {
  if (!req.session.user) return res.status(401).json({error:"Login required"});
  const user = db.prepare("SELECT id,username,role,active,panel_expires_at,balance,max_device_limit FROM users WHERE id=?").get(req.session.user.id);
  if (!user || !user.active) return res.status(403).json({error:"Panel blocked",code:"PANEL_BLOCKED"});
  if (user.role !== "admin") return res.status(403).json({error:"Admin only"});
  req.currentUser = user;
  req.session.user = {...req.session.user, ...user, max_device_limit:user.max_device_limit || 2000};
  next();
}
function panelExpired(user) {
  return user?.role === "reseller" && user.panel_expires_at && new Date(user.panel_expires_at) <= new Date();
}
function makeKey() {
  return "RNTX-" + crypto.randomBytes(9).toString("base64url").toUpperCase();
}
function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
function recordAudit(req, eventType, metadata = {}, user = req.session?.user || null) {
  try {
    const safeMetadata = JSON.stringify(metadata).slice(0, 2000);
    db.prepare(`INSERT INTO audit_logs(event_type,user_id,username,ip_address,metadata)
      VALUES(?,?,?,?,?)`).run(eventType, user?.id || null, user?.username || metadata.username || null, req.ip || null, safeMetadata);
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
}
const rateBuckets = new Map();
function consumeRateLimit(key, windowMs, max) {
  const now = Date.now();
  const existing = rateBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(key, {count: 1, resetAt: now + windowMs});
    if (rateBuckets.size > 5000) {
      for (const [bucketKey, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
    }
    return {allowed: true, retryAfter: 0};
  }
  existing.count += 1;
  return {
    allowed: existing.count <= max,
    retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
  };
}
function rejectRateLimit(req, res, scope, windowMs, max, identity) {
  const result = consumeRateLimit(`${scope}:${identity}`, windowMs, max);
  if (!result.allowed) {
    res.set("Retry-After", String(result.retryAfter));
    recordAudit(req, "RATE_LIMITED", {scope});
    res.status(429).json({error:"Too many requests. Please try again later.", retryAfter:result.retryAfter});
    return true;
  }
  return false;
}
function expiryFromDuration(duration) {
  if (String(duration).toLowerCase() === "lifetime") return null;
  const m = String(duration).match(/(\d+)\s*(hour|hours|day|days|month|months|year|years)/i);
  if (!m) return null;
  const n = Number(m[1]), unit = m[2].toLowerCase();
  const d = new Date();
  if (unit.startsWith("hour")) d.setHours(d.getHours()+n);
  else if (unit.startsWith("day")) d.setDate(d.getDate()+n);
  else if (unit.startsWith("month")) d.setMonth(d.getMonth()+n);
  else d.setFullYear(d.getFullYear()+n);
  return d.toISOString();
}

// Auth
app.post("/api/login",(req,res)=>{
  const username=String(req.body?.username || "").trim().slice(0,100);
  const password=String(req.body?.password || "");
  const panel=String(req.body?.panel || "").toLowerCase();
  const identity=username.toLowerCase() || "unknown";
  if (rejectRateLimit(req,res,"login-ip",15*60*1000,30,req.ip || "unknown") ||
      rejectRateLimit(req,res,"login-account",15*60*1000,8,`${req.ip || "unknown"}:${identity}`)) return;
  const u=db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username);
  if (!u || !password || !bcrypt.compareSync(password,u.password_hash)) {
    recordAudit(req, "LOGIN_FAILED", {username: username || "unknown"});
    return res.status(401).json({error:"Invalid login"});
  }
  if (panel === "admin" && u.role !== "admin") return res.status(403).json({error:"Admin panel access required"});
  if (panel === "reseller" && u.role !== "reseller") return res.status(403).json({error:"Reseller panel access required"});
  if (panel === "reseller" && panelExpired(u)) return res.status(403).json({error:"Reseller panel access has expired",code:"PANEL_EXPIRED"});
  req.session.user={id:u.id,username:u.username,role:u.role,panel_expires_at:u.panel_expires_at,balance:u.balance || 0,max_device_limit:u.max_device_limit || 2000};
  recordAudit(req, "LOGIN_SUCCESS", {}, req.session.user);
  res.json({ok:true,user:req.session.user});
});
app.post("/api/logout",(req,res)=>{
  recordAudit(req, "LOGOUT");
  req.session.destroy(()=>res.json({ok:true}));
});
app.get("/api/me",(req,res)=>{
  if (!req.session.user) return res.json({user:null});
  const user = db.prepare("SELECT id,username,role,max_device_limit,balance,panel_expires_at,active FROM users WHERE id=?").get(req.session.user.id);
  if (!user) return req.session.destroy(() => res.json({user:null}));
  if (!user.active) return res.status(403).json({user:null,error:"Panel blocked",code:"PANEL_BLOCKED"});
  if (panelExpired(user)) return res.status(403).json({user:null,error:"Reseller panel access has expired",code:"PANEL_EXPIRED"});
  req.session.user = {...req.session.user, ...user, max_device_limit:user.max_device_limit || 2000, balance:user.balance || 0};
  res.json({user:req.session.user});
});

function sendPanelPage(panel) {
  return (req,res) => {
    const user = req.session.user && db.prepare("SELECT role,active,panel_expires_at FROM users WHERE id=?").get(req.session.user.id);
    if (user && !user.active) return res.status(403).send("Panel blocked");
    if (user && panel === "admin" && user.role !== "admin") return res.status(403).send("Admin panel access required");
    if (user && panel === "reseller" && user.role !== "reseller") return res.status(403).send("Reseller panel access required");
    if (user && panel === "reseller" && panelExpired(user)) return res.status(403).send("Reseller panel access has expired");
    res.sendFile(path.join(__dirname, "public", "index.html"));
  };
}
app.get("/admin", sendPanelPage("admin"));
app.get("/reseller", sendPanelPage("reseller"));
app.get("/", (req,res) => {
  if (req.session.user?.role === "reseller") return res.redirect("/reseller");
  res.redirect("/admin");
});
app.use(express.static(path.join(__dirname, "public")));

// Dashboard
app.get("/api/dashboard",auth,(req,res)=>{
  const ownerFilter = req.currentUser.role === "reseller" ? " WHERE owner_id=?" : "";
  const ownerArgs = req.currentUser.role === "reseller" ? [req.currentUser.id] : [];
  const total=db.prepare(`SELECT COUNT(*) c FROM keys${ownerFilter}`).get(...ownerArgs).c;
  const used=db.prepare(`SELECT COUNT(*) c FROM keys${ownerFilter}${ownerFilter ? " AND" : " WHERE"} status='ACTIVE'`).get(...ownerArgs).c;
  const unused=db.prepare(`SELECT COUNT(*) c FROM keys${ownerFilter}${ownerFilter ? " AND" : " WHERE"} status='UNUSED'`).get(...ownerArgs).c;
  const blocked=db.prepare(`SELECT COUNT(*) c FROM keys${ownerFilter}${ownerFilter ? " AND" : " WHERE"} status='BLOCKED'`).get(...ownerArgs).c;
  const users=req.currentUser.role === "reseller" ? 1 : db.prepare("SELECT COUNT(*) c FROM users WHERE role!='admin'").get().c;
  const resellers=req.currentUser.role === "reseller" ? 1 : db.prepare("SELECT COUNT(*) c FROM users WHERE role='reseller' AND active=1").get().c;
  const wallet = req.session.user.role === "reseller"
    ? db.prepare("SELECT balance FROM users WHERE id=?").get(req.session.user.id)?.balance || 0
    : null;
  const transactionScope = req.currentUser.role === "reseller" ? " WHERE t.user_id=?" : "";
  const transactionArgs = req.currentUser.role === "reseller" ? [req.currentUser.id] : [];
  const totalCredits = db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM transactions t WHERE t.type='CREDIT'${req.currentUser.role === "reseller" ? " AND t.user_id=?" : ""}`).get(...transactionArgs).total;
  const totalDebits = Math.abs(db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM transactions t WHERE t.type='LICENSE_DEBIT'${req.currentUser.role === "reseller" ? " AND t.user_id=?" : ""}`).get(...transactionArgs).total);
  const recentTransactions = db.prepare(`SELECT t.*,u.username FROM transactions t
    LEFT JOIN users u ON u.id=t.user_id${transactionScope} ORDER BY t.id DESC LIMIT 5`).all(...transactionArgs);
  res.json({total,used,unused,blocked,users,resellers,wallet,totalCredits,totalDebits,recentTransactions});
});

app.get("/api/plans",auth,(req,res)=>{
  res.json(db.prepare("SELECT id,duration,price,active,sort_order,updated_at FROM pricing_plans ORDER BY sort_order,id").all());
});
app.get("/api/pricing-tiers",auth,(req,res)=>{
  res.json(db.prepare("SELECT id,duration,device_limit,price,active,sort_order,updated_at FROM pricing_tiers ORDER BY sort_order,device_limit").all());
});
app.patch("/api/pricing-tiers/:id",adminOnly,(req,res)=>{
  const price = Number(req.body.price);
  if (!Number.isInteger(price) || price < 0 || price > 100000000) return res.status(400).json({error:"Price must be a whole number between ₹0 and ₹100,000,000"});
  const tier = db.prepare("SELECT id,duration,device_limit FROM pricing_tiers WHERE id=?").get(req.params.id);
  if (!tier) return res.status(404).json({error:"Pricing tier not found"});
  db.prepare("UPDATE pricing_tiers SET price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(price,tier.id);
  recordAudit(req,"PRICING_TIER_UPDATED",{tierId:tier.id,duration:tier.duration,deviceLimit:tier.device_limit,price});
  res.json({ok:true});
});
app.patch("/api/plans/:id",adminOnly,(req,res)=>{
  const price = Number(req.body.price);
  if (!Number.isInteger(price) || price < 0 || price > 100000000) return res.status(400).json({error:"Price must be a whole number between ₹0 and ₹100,000,000"});
  const plan = db.prepare("SELECT id FROM pricing_plans WHERE id=?").get(req.params.id);
  if (!plan) return res.status(404).json({error:"Pricing plan not found"});
  db.prepare("UPDATE pricing_plans SET price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(price, plan.id);
  recordAudit(req, "PRICING_UPDATED", {planId:plan.id, price});
  res.json({ok:true});
});

// Keys
app.get("/api/keys",auth,(req,res)=>{
  const q=(req.query.q||"").trim();
  let rows;
  if(req.session.user.role==="admin") {
    rows=db.prepare(`SELECT k.*,u.username owner FROM keys k LEFT JOIN users u ON u.id=k.owner_id
      WHERE k.license_key LIKE ? OR k.game LIKE ? OR k.duration LIKE ? ORDER BY k.id DESC LIMIT 200`)
      .all(`%${q}%`,`%${q}%`,`%${q}%`);
  } else {
    rows=db.prepare(`SELECT k.*,u.username owner FROM keys k LEFT JOIN users u ON u.id=k.owner_id
      WHERE k.owner_id=? AND (k.license_key LIKE ? OR k.game LIKE ? OR k.duration LIKE ?)
      ORDER BY k.id DESC LIMIT 200`).all(req.session.user.id,`%${q}%`,`%${q}%`,`%${q}%`);
  }
  res.json(rows);
});

app.post("/api/keys",auth,(req,res)=>{
  const {game="My APK",duration="Lifetime",maxDevices=1}=req.body;
  const owner=req.session.user.id;
  const quantity = Number(req.body.quantity ?? 1);
  const devices = Number(maxDevices);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({error:"Quantity must be between 1 and 100"});
  if (!Number.isInteger(devices) || devices < 1 || devices > 2000) return res.status(400).json({error:"Device limit must be between 1 and 2000"});
  const cleanGame = String(game || "My APK").trim().slice(0,100) || "My APK";
  const isReseller = req.session.user.role === "reseller";
  const account = db.prepare("SELECT balance,active,max_device_limit FROM users WHERE id=?").get(owner);
  const maxAllowed = account?.max_device_limit || 2000;
  if (isReseller && devices > maxAllowed) return res.status(400).json({error:`This reseller is limited to ${maxAllowed} devices per key`});
  const tier = db.prepare("SELECT * FROM pricing_tiers WHERE duration=? AND device_limit=? AND active=1").get(duration,devices);
  if (isReseller && !tier) return res.status(400).json({error:"Choose an active duration and device limit"});
  const unitPrice = isReseller ? tier.price : 0;
  const total = unitPrice * quantity;
  try {
    const result = db.transaction(() => {
      const current = db.prepare("SELECT balance,active,max_device_limit FROM users WHERE id=?").get(owner);
      if (!current || !current.active) throw new Error("Account is inactive");
      if (isReseller && devices > (current.max_device_limit || 2000)) throw new Error(`This reseller is limited to ${current.max_device_limit || 2000} devices per key`);
      const before = current.balance || 0;
      if (isReseller && before < total) throw new Error("Insufficient wallet balance. Please contact admin to add balance.");
      const after = before - total;
      const orderId = isReseller ? makeId("ORD") : null;
      if (isReseller) {
        const updated = db.prepare("UPDATE users SET balance=? WHERE id=? AND balance=?").run(after, owner, before);
        if (updated.changes !== 1) throw new Error("Balance changed. Please try again.");
        db.prepare(`INSERT INTO orders(order_id,reseller_id,duration,device_limit,unit_price,quantity,total_amount,balance_before,balance_after)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(orderId,owner,duration,devices,unitPrice,quantity,total,before,after);
      }
      const keys = [];
      const insert = db.prepare(`INSERT INTO keys(license_key,game,duration,expires_at,max_devices,owner_id,price_paid,order_id)
        VALUES(?,?,?,?,?,?,?,?)`);
      for (let i=0;i<quantity;i++) {
        const key = makeKey();
        const expires = expiryFromDuration(duration);
        insert.run(key,cleanGame,duration,expires,devices,owner,unitPrice,orderId);
        keys.push({key,expires_at:expires});
      }
      if (isReseller) {
        db.prepare(`INSERT INTO transactions(transaction_id,user_id,type,amount,balance_before,balance_after,description,related_order_id)
          VALUES(?,?,?,?,?,?,?,?)`).run(
          makeId("TXN"), owner, "LICENSE_DEBIT", -total, before, after,
          `${duration} / ${devices} device${devices === 1 ? "" : "s"} × ${quantity}`, orderId
        );
      }
      return {keys,orderId,balanceBefore:before,balanceAfter:after,unitPrice,total};
    })();
    recordAudit(req, "LICENSE_PURCHASED", {
      orderId: result.orderId, duration, deviceLimit: devices, quantity, total: result.total, unitPrice: result.unitPrice
    });
    res.json({ok:true,...result,key:result.keys[0].key,expires_at:result.keys[0].expires_at});
  } catch (e) {
    const message = e.message.includes("Insufficient") ? e.message : (e.message.includes("inactive") ? e.message : "Could not create license purchase");
    recordAudit(req, "LICENSE_PURCHASE_FAILED", {duration, quantity, reason: message});
    res.status(message.startsWith("Insufficient") || message === "Account is inactive" ? 400 : 500).json({error:message});
  }
});
app.patch("/api/keys/:id",auth,(req,res)=>{
  const row=db.prepare("SELECT * FROM keys WHERE id=?").get(req.params.id);
  if(!row) return res.status(404).json({error:"Key not found"});
  if(req.session.user.role!=="admin" && row.owner_id!==req.session.user.id) return res.status(403).json({error:"Not allowed"});
  const status=req.body.status;
  if(["UNUSED","ACTIVE","BLOCKED"].includes(status))
    db.prepare("UPDATE keys SET status=? WHERE id=?").run(status,row.id);
  recordAudit(req, "LICENSE_STATUS_CHANGED", {keyId:row.id, status});
  res.json({ok:true});
});
app.delete("/api/keys/:id",auth,(req,res)=>{
  const row=db.prepare("SELECT * FROM keys WHERE id=?").get(req.params.id);
  if(!row) return res.status(404).json({error:"Key not found"});
  if(req.session.user.role!=="admin" && row.owner_id!==req.session.user.id) return res.status(403).json({error:"Not allowed"});
  db.prepare("DELETE FROM keys WHERE id=?").run(row.id);
  recordAudit(req, "LICENSE_DELETED", {keyId:row.id});
  res.json({ok:true});
});

// APK verification endpoint
app.post("/api/activate",(req,res)=>{
  if (rejectRateLimit(req,res,"activation-ip",60*1000,60,req.ip || "unknown")) return;
  const {licenseKey,deviceId}=req.body;
  if(!licenseKey || !deviceId) {
    recordAudit(req, "ACTIVATION_FAILED", {reason:"missing_fields"});
    return res.status(400).json({valid:false,error:"licenseKey and deviceId required"});
  }
  const k=db.prepare("SELECT * FROM keys WHERE license_key=?").get(licenseKey);
  if(!k) {
    recordAudit(req, "ACTIVATION_FAILED", {reason:"invalid_key"});
    return res.status(404).json({valid:false,error:"Invalid key"});
  }
  if(k.status==="BLOCKED") {
    recordAudit(req, "ACTIVATION_FAILED", {keyId:k.id,reason:"blocked_key"});
    return res.status(403).json({valid:false,error:"Key blocked"});
  }
  if(k.expires_at && new Date(k.expires_at) <= new Date()) {
    db.prepare("UPDATE keys SET status='EXPIRED' WHERE id=?").run(k.id);
    recordAudit(req, "ACTIVATION_FAILED", {keyId:k.id,reason:"expired_key"});
    return res.status(403).json({valid:false,error:"Key expired"});
  }
  const existing=db.prepare("SELECT id FROM devices WHERE key_id=? AND device_id=?").get(k.id,deviceId);
  if(!existing) {
    if(k.devices_used >= k.max_devices) {
      recordAudit(req, "ACTIVATION_FAILED", {keyId:k.id,reason:"device_limit"});
      return res.status(403).json({valid:false,error:"Device limit reached"});
    }
    db.prepare("INSERT INTO devices(key_id,device_id) VALUES(?,?)").run(k.id,deviceId);
    db.prepare("UPDATE keys SET devices_used=devices_used+1,status='ACTIVE' WHERE id=?").run(k.id);
  }
  res.json({valid:true,game:k.game,duration:k.duration,expires_at:k.expires_at,max_devices:k.max_devices});
});

// Admin/reseller management
app.get("/api/users",adminOnly,(req,res)=>{
  res.json(db.prepare(`SELECT u.id,u.username,u.role,u.referral_code,u.parent_id,u.panel_expires_at,u.balance,u.max_device_limit,u.active,u.created_at,
    COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id AND type='CREDIT'),0) total_credits,
    ABS(COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id AND type='LICENSE_DEBIT'),0)) total_debits
    FROM users u ORDER BY u.id DESC`).all().map(user => ({...user,max_device_limit:user.max_device_limit || 2000})));
});
app.post("/api/users",adminOnly,(req,res)=>{
  const {username,password,role="reseller",days=null,parentId=null,maxDeviceLimit=2000}=req.body;
  if(!username || !password) return res.status(400).json({error:"Username/password required"});
  if(!["reseller","admin"].includes(role)) return res.status(400).json({error:"Invalid role"});
  if (role !== "reseller") return res.status(400).json({error:"Only reseller accounts can be created here"});
  const parsedLimit = Number(maxDeviceLimit);
  if (!Number.isInteger(parsedLimit) || !tierLimits.includes(parsedLimit)) return res.status(400).json({error:"Maximum device limit must be one of the configured device tiers"});
  const hash=bcrypt.hashSync(password,12);
  const code="RNTX-"+crypto.randomBytes(4).toString("hex").toUpperCase();
  let exp=null;
  if(days !== null && days !== "" && (!Number.isInteger(Number(days)) || Number(days) <= 0)) return res.status(400).json({error:"Panel days must be a positive whole number or blank for lifetime"});
  if(days !== null && days !== ""){const d=new Date();d.setDate(d.getDate()+Number(days));exp=d.toISOString();}
  try {
    const info=db.prepare(`INSERT INTO users(username,password_hash,role,referral_code,parent_id,panel_expires_at,max_device_limit)
      VALUES(?,?,?,?,?,?,?)`).run(username,hash,role,code,parentId||null,exp,parsedLimit);
    recordAudit(req, "USER_CREATED", {userId:info.lastInsertRowid, username, role});
    res.json({ok:true,id:info.lastInsertRowid,referral_code:code});
  } catch(e){res.status(400).json({error:"Username already exists"});}
});
app.patch("/api/users/:id",adminOnly,(req,res)=>{
  const user = db.prepare("SELECT id,username,role,panel_expires_at,active,max_device_limit FROM users WHERE id=?").get(req.params.id);
  if (!user || user.role !== "reseller") return res.status(404).json({error:"Reseller not found"});
  const active=req.body.active;
  if(active!==undefined) db.prepare("UPDATE users SET active=? WHERE id=?").run(active?1:0,req.params.id);
  if(req.body.maxDeviceLimit!==undefined) {
    const maxDeviceLimit = Number(req.body.maxDeviceLimit);
    if(!Number.isInteger(maxDeviceLimit) || !tierLimits.includes(maxDeviceLimit)) return res.status(400).json({error:"Maximum device limit must be one of the configured device tiers"});
    db.prepare("UPDATE users SET max_device_limit=? WHERE id=?").run(maxDeviceLimit,req.params.id);
    recordAudit(req,"RESELLER_DEVICE_LIMIT_UPDATED",{userId:Number(req.params.id),maxDeviceLimit});
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "panelDays")) {
    const rawDays = req.body.panelDays;
    if (rawDays !== null && rawDays !== "" && (!Number.isInteger(Number(rawDays)) || Number(rawDays) <= 0)) {
      return res.status(400).json({error:"Panel days must be a positive whole number or blank for lifetime"});
    }
    let expires = null;
    if (rawDays !== null && rawDays !== "") {
      const d = new Date();
      d.setDate(d.getDate() + Number(rawDays));
      expires = d.toISOString();
    }
    db.prepare("UPDATE users SET panel_expires_at=? WHERE id=?").run(expires,req.params.id);
    recordAudit(req,"RESELLER_PANEL_EXPIRY_UPDATED",{userId:Number(req.params.id),panelDays:rawDays === "" || rawDays === null ? null : Number(rawDays),panelExpiresAt:expires});
  }
  if(active!==undefined) recordAudit(req, "USER_STATUS_CHANGED", {userId:Number(req.params.id),active:Boolean(active)});
  res.json({ok:true,user:db.prepare("SELECT id,username,role,panel_expires_at,active,max_device_limit,balance FROM users WHERE id=?").get(req.params.id)});
});

app.post("/api/users/:id/balance",adminOnly,(req,res)=>{
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000000) return res.status(400).json({error:"Credit must be a whole number greater than ₹0"});
  const description = String(req.body.description || "Admin wallet credit").trim().slice(0,200) || "Admin wallet credit";
  try {
    const result = db.transaction(() => {
      const user = db.prepare("SELECT id,username,balance,role,active FROM users WHERE id=?").get(req.params.id);
      if (!user || user.role !== "reseller") throw new Error("Reseller not found");
      const before = user.balance || 0, after = before + amount;
      db.prepare("UPDATE users SET balance=? WHERE id=? AND balance=?").run(after,user.id,before);
      db.prepare(`INSERT INTO transactions(transaction_id,user_id,type,amount,balance_before,balance_after,description,performed_by,performed_by_username)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(makeId("TXN"),user.id,"CREDIT",amount,before,after,description,req.currentUser.id,req.currentUser.username);
      return {username:user.username,balanceBefore:before,balanceAfter:after};
    })();
    recordAudit(req, "WALLET_CREDITED", {userId:Number(req.params.id),amount:amount,balanceAfter:result.balanceAfter});
    res.json({ok:true,...result});
  } catch(e) { res.status(400).json({error:e.message || "Could not add balance"}); }
});

app.get("/api/transactions",auth,(req,res)=>{
  const requested = req.session.user.role === "admin" && req.query.userId ? Number(req.query.userId) : req.session.user.id;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = db.prepare(`SELECT t.*,u.username FROM transactions t
    LEFT JOIN users u ON u.id=t.user_id
    WHERE t.user_id=? ORDER BY t.id DESC LIMIT ?`).all(requested,limit);
  res.json(rows);
});

app.get("/api/audit-logs",adminOnly,(req,res)=>{
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(db.prepare(`SELECT id,event_type,user_id,username,ip_address,metadata,created_at
    FROM audit_logs ORDER BY id DESC LIMIT ?`).all(limit));
});

app.get("/api/referrals",auth,(req,res)=>{
  const id=req.session.user.id;
  res.json(db.prepare(`SELECT u.id,u.username,u.role,u.referral_code,u.active,u.created_at
    FROM users u WHERE u.parent_id=? ORDER BY u.id DESC`).all(id));
});

app.listen(PORT,"0.0.0.0",()=>console.log(`RNTX Admin Panel running on port ${PORT}`));
