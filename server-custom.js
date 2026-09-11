const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const session = require("express-session");

// Render/Replit can restart the Node process while the browser still has the
// session cookie. The default express-session MemoryStore then loses the
// session and protected actions incorrectly return "Login required". Keep
// sessions in a small SQLite store so restarts do not invalidate the browser
// session immediately.
class SQLiteSessionStore extends session.Store {
  constructor(filename = "rntx-sessions.db") {
    super();
    this.db = new Database(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires_at INTEGER
    )`);
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare("SELECT sess,expires_at FROM sessions WHERE sid=?").get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at && row.expires_at <= Date.now()) {
        this.db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }
  set(sid, sess, cb) {
    try {
      const expiresAt = sess?.cookie?.expires ? Date.parse(sess.cookie.expires) :
        (sess?.cookie?.maxAge ? Date.now() + Number(sess.cookie.maxAge) : null);
      this.db.prepare("INSERT OR REPLACE INTO sessions(sid,sess,expires_at) VALUES(?,?,?)")
        .run(sid, JSON.stringify(sess), Number.isFinite(expiresAt) ? expiresAt : null);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }
  destroy(sid, cb) {
    try { this.db.prepare("DELETE FROM sessions WHERE sid=?").run(sid); cb && cb(null); }
    catch (err) { cb && cb(err); }
  }
  touch(sid, sess, cb) {
    try {
      const expiresAt = sess?.cookie?.expires ? Date.parse(sess.cookie.expires) :
        (sess?.cookie?.maxAge ? Date.now() + Number(sess.cookie.maxAge) : null);
      this.db.prepare("UPDATE sessions SET expires_at=? WHERE sid=?")
        .run(Number.isFinite(expiresAt) ? expiresAt : null, sid);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }
}

const persistentSession = session;
const originalSessionMiddleware = session;
function sessionWithPersistentStore(options = {}) {
  return originalSessionMiddleware({ ...options, store: options.store || new SQLiteSessionStore() });
}
Object.setPrototypeOf(sessionWithPersistentStore, persistentSession);
for (const key of Object.keys(persistentSession)) sessionWithPersistentStore[key] = persistentSession[key];
require.cache[require.resolve("express-session")].exports = sessionWithPersistentStore;

const originalPost = express.application.post;
const originalGet = express.application.get;
const originalListen = express.application.listen;
const originalPrepare = Database.prototype.prepare;
let capturedApp = null;
let listenArgs = null;

express.application.get = function(routePath, ...handlers) {
  if ((routePath === "/admin" || routePath === "/reseller") && handlers.length) {
    const panel = routePath === "/reseller" ? "reseller" : "admin";
    const originalHandler = handlers[handlers.length - 1];
    handlers[handlers.length - 1] = function(req, res, next) {
      const currentRole = req.session?.user?.role;
      if (currentRole && currentRole !== panel) {
        return req.session.destroy(() => {
          res.sendFile(path.join(__dirname, "public", "index.html"));
        });
      }
      return originalHandler(req, res, next);
    };
  }
  return originalGet.call(this, routePath, ...handlers);
};

Database.prototype.prepare = function(sql) {
  const statement = originalPrepare.call(this, sql);
  if (String(sql).replace(/\s+/g, " ").trim() === "SELECT * FROM pricing_tiers WHERE duration=? AND device_limit=? AND active=1") {
    const db = this;
    const originalGet = statement.get.bind(statement);
    statement.get = function(duration, devices) {
      const plan = originalPrepare.call(db, "SELECT price FROM pricing_plans WHERE duration=? AND active=1").get(duration);
      if (!plan) return originalGet(duration, devices);
      return {duration, device_limit:Number(devices), price:Number(plan.price)*Number(devices), active:1};
    };
  }
  return statement;
};

express.application.post = function(routePath, ...handlers) {
  if (routePath === "/api/keys" && handlers.length) {
    const originalHandler = handlers[handlers.length - 1];
    handlers[handlers.length - 1] = function(req, res, next) {
      const devices = Number(req.body?.maxDevices);
      if (!Number.isInteger(devices) || devices < 1 || devices > 2000) {
        return res.status(400).json({error:"Device count must be a whole number between 1 and 2000"});
      }
      req.body.maxDevices = devices;
      return originalHandler(req,res,next);
    };
  }
  return originalPost.call(this, routePath, ...handlers);
};

express.application.listen = function(...args) {
  capturedApp = this;
  listenArgs = args;
  return {close(){}};
};

require("./server.js");
if (!capturedApp || !listenArgs) throw new Error("Could not initialize RNTX server wrapper");

const db = new Database("rntx.db");

capturedApp.post("/api/pricing-tiers/custom", (req,res)=>{
  const sessionUser=req.session?.user;
  if(!sessionUser)return res.status(401).json({error:"Login required"});
  const user=db.prepare("SELECT id,username,role,active FROM users WHERE id=?").get(sessionUser.id);
  const mainAdmin=db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1").get();
  if(!user||!user.active||user.role!=="admin"||!mainAdmin||user.id!==mainAdmin.id)return res.status(403).json({error:"Main admin only"});
  const duration=String(req.body?.duration||"").trim().slice(0,50);
  const deviceLimit=Number(req.body?.deviceLimit);
  const price=Number(req.body?.price);
  if(!duration)return res.status(400).json({error:"Duration is required"});
  if(!Number.isInteger(deviceLimit)||deviceLimit<1||deviceLimit>2000)return res.status(400).json({error:"Custom device count must be a whole number from 1 to 2000"});
  if(!Number.isInteger(price)||price<0||price>100000000)return res.status(400).json({error:"Price must be a whole number between ₹0 and ₹100,000,000"});
  const plan=db.prepare("SELECT duration FROM pricing_plans WHERE duration=? AND active=1").get(duration);
  if(!plan)return res.status(400).json({error:"Choose an active license duration"});
  const existing=db.prepare("SELECT id FROM pricing_tiers WHERE duration=? AND device_limit=?").get(duration,deviceLimit);
  if(existing)db.prepare("UPDATE pricing_tiers SET price=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(price,existing.id);
  else db.prepare("INSERT INTO pricing_tiers(duration,device_limit,price,active,sort_order) VALUES(?,?,?,1,?)").run(duration,deviceLimit,price,1);
  try{db.prepare(`INSERT INTO audit_logs(event_type,user_id,username,metadata) VALUES(?,?,?,?)`).run("CUSTOM_PRICING_TIER_UPDATED",user.id,user.username,JSON.stringify({duration,deviceLimit,price}));}catch{}
  res.json({ok:true,duration,device_limit:deviceLimit,price});
});

// Compatibility read aliases for older frontend builds. They use the same
// authenticated data and do not bypass authorization.
capturedApp.get("/api/pricing", (req,res,next)=> {
  const user=req.session?.user;
  if(!user)return res.status(401).json({error:"Login required"});
  const rows=db.prepare("SELECT id,duration,price,active,sort_order,updated_at FROM pricing_plans ORDER BY sort_order,id").all();
  res.json(rows);
});
capturedApp.get("/api/audit", (req,res,next)=> {
  const user=req.session?.user;
  if(!user)return res.status(401).json({error:"Login required"});
  const fresh=db.prepare("SELECT id,event_type,user_id,username,ip_address,metadata,created_at FROM audit_logs ORDER BY id DESC LIMIT 200").all();
  res.json(fresh);
});

originalListen.apply(capturedApp, listenArgs);
