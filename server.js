const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
const db = new Database("rntx.db");
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "CHANGE_THIS_IN_REPLIT_SECRETS";

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 7*24*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

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

db.exec(`
CREATE TABLE IF NOT EXISTS pricing_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duration TEXT UNIQUE NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  reseller_id INTEGER NOT NULL,
  duration TEXT NOT NULL,
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
`);

const defaultPlans = [
  ["5 Hours", 50, 1], ["12 Hours", 100, 2], ["1 Day", 150, 3],
  ["7 Days", 400, 4], ["15 Days", 700, 5], ["1 Month", 900, 6],
  ["2 Months", 1200, 7], ["Lifetime", 5000, 8]
];
const insertPlan = db.prepare("INSERT OR IGNORE INTO pricing_plans(duration,price,sort_order) VALUES(?,?,?)");
for (const plan of defaultPlans) insertPlan.run(...plan);

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
  next();
}
function adminOnly(req,res,next) {
  if (!req.session.user || req.session.user.role !== "admin") return res.status(403).json({error:"Admin only"});
  next();
}
function makeKey() {
  return "RNTX-" + crypto.randomBytes(9).toString("base64url").toUpperCase();
}
function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
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
  const {username,password}=req.body;
  const u=db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username);
  if (!u || !bcrypt.compareSync(password,u.password_hash)) return res.status(401).json({error:"Invalid login"});
  req.session.user={id:u.id,username:u.username,role:u.role};
  res.json({ok:true,user:req.session.user});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({user:req.session.user||null}));

// Dashboard
app.get("/api/dashboard",auth,(req,res)=>{
  const total=db.prepare("SELECT COUNT(*) c FROM keys").get().c;
  const used=db.prepare("SELECT COUNT(*) c FROM keys WHERE status='ACTIVE'").get().c;
  const unused=db.prepare("SELECT COUNT(*) c FROM keys WHERE status='UNUSED'").get().c;
  const blocked=db.prepare("SELECT COUNT(*) c FROM keys WHERE status='BLOCKED'").get().c;
  const users=db.prepare("SELECT COUNT(*) c FROM users WHERE role!='admin'").get().c;
  const resellers=db.prepare("SELECT COUNT(*) c FROM users WHERE role='reseller' AND active=1").get().c;
  const wallet = req.session.user.role === "reseller"
    ? db.prepare("SELECT balance FROM users WHERE id=?").get(req.session.user.id)?.balance || 0
    : null;
  const totalCredits = db.prepare("SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE type='CREDIT'").get().total;
  const totalDebits = Math.abs(db.prepare("SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE type='LICENSE_DEBIT'").get().total);
  const recentTransactions = db.prepare(`SELECT t.*,u.username FROM transactions t
    LEFT JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 5`).all();
  res.json({total,used,unused,blocked,users,resellers,wallet,totalCredits,totalDebits,recentTransactions});
});

app.get("/api/plans",auth,(req,res)=>{
  res.json(db.prepare("SELECT id,duration,price,active,sort_order,updated_at FROM pricing_plans ORDER BY sort_order,id").all());
});
app.patch("/api/plans/:id",adminOnly,(req,res)=>{
  const price = Number(req.body.price);
  if (!Number.isInteger(price) || price < 0 || price > 100000000) return res.status(400).json({error:"Price must be a whole number between ₹0 and ₹100,000,000"});
  const plan = db.prepare("SELECT id FROM pricing_plans WHERE id=?").get(req.params.id);
  if (!plan) return res.status(404).json({error:"Pricing plan not found"});
  db.prepare("UPDATE pricing_plans SET price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(price, plan.id);
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
  if (!Number.isInteger(devices) || devices < 1 || devices > 1000) return res.status(400).json({error:"Device limit must be between 1 and 1000"});
  const cleanGame = String(game || "My APK").trim().slice(0,100) || "My APK";
  const isReseller = req.session.user.role === "reseller";
  const plan = db.prepare("SELECT * FROM pricing_plans WHERE duration=? AND active=1").get(duration);
  if (isReseller && !plan) return res.status(400).json({error:"Choose an active pricing plan"});
  const unitPrice = isReseller ? plan.price : 0;
  const total = unitPrice * quantity;
  try {
    const result = db.transaction(() => {
      const current = db.prepare("SELECT balance,active FROM users WHERE id=?").get(owner);
      if (!current || !current.active) throw new Error("Account is inactive");
      const before = current.balance || 0;
      if (isReseller && before < total) throw new Error("Insufficient balance. Please contact admin to add balance.");
      const after = before - total;
      const orderId = isReseller ? makeId("ORD") : null;
      if (isReseller) {
        const updated = db.prepare("UPDATE users SET balance=? WHERE id=? AND balance=?").run(after, owner, before);
        if (updated.changes !== 1) throw new Error("Balance changed. Please try again.");
        db.prepare(`INSERT INTO orders(order_id,reseller_id,duration,unit_price,quantity,total_amount,balance_before,balance_after)
          VALUES(?,?,?,?,?,?,?,?)`).run(orderId,owner,duration,unitPrice,quantity,total,before,after);
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
          `${duration} license${quantity === 1 ? "" : "s"} × ${quantity}`, orderId
        );
      }
      return {keys,orderId,balanceBefore:before,balanceAfter:after,unitPrice,total};
    })();
    res.json({ok:true,...result,key:result.keys[0].key,expires_at:result.keys[0].expires_at});
  } catch (e) {
    const message = e.message.includes("Insufficient") ? e.message : (e.message.includes("inactive") ? e.message : "Could not create license purchase");
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
  res.json({ok:true});
});
app.delete("/api/keys/:id",auth,(req,res)=>{
  const row=db.prepare("SELECT * FROM keys WHERE id=?").get(req.params.id);
  if(!row) return res.status(404).json({error:"Key not found"});
  if(req.session.user.role!=="admin" && row.owner_id!==req.session.user.id) return res.status(403).json({error:"Not allowed"});
  db.prepare("DELETE FROM keys WHERE id=?").run(row.id);
  res.json({ok:true});
});

// APK verification endpoint
app.post("/api/activate",(req,res)=>{
  const {licenseKey,deviceId}=req.body;
  if(!licenseKey || !deviceId) return res.status(400).json({valid:false,error:"licenseKey and deviceId required"});
  const k=db.prepare("SELECT * FROM keys WHERE license_key=?").get(licenseKey);
  if(!k) return res.status(404).json({valid:false,error:"Invalid key"});
  if(k.status==="BLOCKED") return res.status(403).json({valid:false,error:"Key blocked"});
  if(k.expires_at && new Date(k.expires_at) <= new Date()) {
    db.prepare("UPDATE keys SET status='EXPIRED' WHERE id=?").run(k.id);
    return res.status(403).json({valid:false,error:"Key expired"});
  }
  const existing=db.prepare("SELECT id FROM devices WHERE key_id=? AND device_id=?").get(k.id,deviceId);
  if(!existing) {
    if(k.devices_used >= k.max_devices) return res.status(403).json({valid:false,error:"Device limit reached"});
    db.prepare("INSERT INTO devices(key_id,device_id) VALUES(?,?)").run(k.id,deviceId);
    db.prepare("UPDATE keys SET devices_used=devices_used+1,status='ACTIVE' WHERE id=?").run(k.id);
  }
  res.json({valid:true,game:k.game,duration:k.duration,expires_at:k.expires_at,max_devices:k.max_devices});
});

// Admin/reseller management
app.get("/api/users",adminOnly,(req,res)=>{
  res.json(db.prepare(`SELECT u.id,u.username,u.role,u.referral_code,u.parent_id,u.panel_expires_at,u.balance,u.active,u.created_at,
    COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id AND type='CREDIT'),0) total_credits,
    ABS(COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=u.id AND type='LICENSE_DEBIT'),0)) total_debits
    FROM users u ORDER BY u.id DESC`).all());
});
app.post("/api/users",adminOnly,(req,res)=>{
  const {username,password,role="reseller",days=null,parentId=null}=req.body;
  if(!username || !password) return res.status(400).json({error:"Username/password required"});
  if(!["reseller","admin"].includes(role)) return res.status(400).json({error:"Invalid role"});
  const hash=bcrypt.hashSync(password,12);
  const code="RNTX-"+crypto.randomBytes(4).toString("hex").toUpperCase();
  let exp=null;
  if(days && Number(days)>0){const d=new Date();d.setDate(d.getDate()+Number(days));exp=d.toISOString();}
  try {
    const info=db.prepare(`INSERT INTO users(username,password_hash,role,referral_code,parent_id,panel_expires_at)
      VALUES(?,?,?,?,?,?)`).run(username,hash,role,code,parentId||null,exp);
    res.json({ok:true,id:info.lastInsertRowid,referral_code:code});
  } catch(e){res.status(400).json({error:"Username already exists"});}
});
app.patch("/api/users/:id",adminOnly,(req,res)=>{
  const active=req.body.active;
  if(active!==undefined) db.prepare("UPDATE users SET active=? WHERE id=?").run(active?1:0,req.params.id);
  res.json({ok:true});
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
      db.prepare(`INSERT INTO transactions(transaction_id,user_id,type,amount,balance_before,balance_after,description)
        VALUES(?,?,?,?,?,?,?)`).run(makeId("TXN"),user.id,"CREDIT",amount,before,after,description);
      return {username:user.username,balanceBefore:before,balanceAfter:after};
    })();
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

app.get("/api/referrals",auth,(req,res)=>{
  const id=req.session.user.id;
  res.json(db.prepare(`SELECT u.id,u.username,u.role,u.referral_code,u.active,u.created_at
    FROM users u WHERE u.parent_id=? ORDER BY u.id DESC`).all(id));
});

app.listen(PORT,()=>console.log(`RNTX Admin Panel running on port ${PORT}`));
