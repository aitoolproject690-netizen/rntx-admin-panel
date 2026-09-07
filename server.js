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
  res.json({total,used,unused,blocked,users,resellers});
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
  const key=makeKey(), expires=expiryFromDuration(duration);
  db.prepare(`INSERT INTO keys(license_key,game,duration,expires_at,max_devices,owner_id)
              VALUES(?,?,?,?,?,?)`).run(key,game,duration,expires,Number(maxDevices)||1,owner);
  res.json({ok:true,key,expires_at:expires});
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
  res.json(db.prepare(`SELECT id,username,role,referral_code,parent_id,panel_expires_at,balance,active,created_at
    FROM users ORDER BY id DESC`).all());
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

app.get("/api/referrals",auth,(req,res)=>{
  const id=req.session.user.id;
  res.json(db.prepare(`SELECT u.id,u.username,u.role,u.referral_code,u.active,u.created_at
    FROM users u WHERE u.parent_id=? ORDER BY u.id DESC`).all(id));
});

app.listen(PORT,()=>console.log(`RNTX Admin Panel running on port ${PORT}`));
