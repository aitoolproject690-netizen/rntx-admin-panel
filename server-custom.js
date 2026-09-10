const express = require("express");
const Database = require("better-sqlite3");

const originalPost = express.application.post;
const originalListen = express.application.listen;
const originalPrepare = Database.prototype.prepare;
let capturedApp = null;
let listenArgs = null;

// The panel uses duration pricing as a per-device price. Keep the existing
// server key-generation flow, but make its pricing lookup return
// (duration price × requested devices) for reseller purchases.
Database.prototype.prepare = function(sql) {
  const statement = originalPrepare.call(this, sql);
  if (String(sql).replace(/\s+/g, " ").trim() === "SELECT * FROM pricing_tiers WHERE duration=? AND device_limit=? AND active=1") {
    const db = this;
    const originalGet = statement.get.bind(statement);
    statement.get = function(duration, devices) {
      const plan = originalPrepare.call(db, "SELECT price FROM pricing_plans WHERE duration=? AND active=1").get(duration);
      if (!plan) return originalGet(duration, devices);
      return {
        duration,
        device_limit: Number(devices),
        price: Number(plan.price) * Number(devices),
        active: 1
      };
    };
  }
  return statement;
};

// Extend the existing /api/keys route validation while preserving the
// original handler and its transactional wallet/order/key logic.
express.application.post = function(path, ...handlers) {
  if (path === "/api/keys" && handlers.length) {
    const originalHandler = handlers[handlers.length - 1];
    handlers[handlers.length - 1] = function(req, res, next) {
      const devices = Number(req.body?.maxDevices);
      if (!Number.isInteger(devices) || devices < 1 || devices > 2000) {
        return res.status(400).json({error: "Device count must be a whole number between 1 and 2000"});
      }
      req.body.maxDevices = devices;
      return originalHandler(req, res, next);
    };
  }
  return originalPost.call(this, path, ...handlers);
};

// server.js starts listening during require(). Capture that call so we can
// add the custom pricing endpoint after all original middleware is installed.
express.application.listen = function(...args) {
  capturedApp = this;
  listenArgs = args;
  return { close() {} };
};

require("./server.js");

if (!capturedApp || !listenArgs) throw new Error("Could not initialize RNTX server wrapper");

const db = new Database("rntx.db");

// Kept for compatibility with the previous build; the main pricing UI now
// edits pricing_plans (the per-device duration price), so this endpoint is no
// longer required by the normal UI.
capturedApp.post("/api/pricing-tiers/custom", (req, res) => {
  const sessionUser = req.session?.user;
  if (!sessionUser) return res.status(401).json({error: "Login required"});
  const user = db.prepare("SELECT id,username,role,active FROM users WHERE id=?").get(sessionUser.id);
  const mainAdmin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1").get();
  if (!user || !user.active || user.role !== "admin" || !mainAdmin || user.id !== mainAdmin.id) return res.status(403).json({error: "Main admin only"});
  const duration = String(req.body?.duration || "").trim().slice(0, 50);
  const deviceLimit = Number(req.body?.deviceLimit);
  const price = Number(req.body?.price);
  if (!duration) return res.status(400).json({error: "Duration is required"});
  if (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 2000) return res.status(400).json({error: "Custom device count must be a whole number between 1 and 2000"});
  if (!Number.isInteger(price) || price < 0 || price > 100000000) return res.status(400).json({error: "Price must be a whole number between ₹0 and ₹100,000,000"});
  const plan = db.prepare("SELECT duration FROM pricing_plans WHERE duration=? AND active=1").get(duration);
  if (!plan) return res.status(400).json({error: "Choose an active license duration"});
  const existing = db.prepare("SELECT id FROM pricing_tiers WHERE duration=? AND device_limit=?").get(duration, deviceLimit);
  if (existing) db.prepare("UPDATE pricing_tiers SET price=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(price, existing.id);
  else db.prepare("INSERT INTO pricing_tiers(duration,device_limit,price,active,sort_order) VALUES(?,?,?,1,?)").run(duration, deviceLimit, price, 1);
  try { db.prepare(`INSERT INTO audit_logs(event_type,user_id,username,metadata) VALUES(?,?,?,?)`).run("CUSTOM_PRICING_TIER_UPDATED",user.id,user.username,JSON.stringify({duration,deviceLimit,price})); } catch {}
  res.json({ok:true,duration,device_limit:deviceLimit,price});
});

originalListen.apply(capturedApp, listenArgs);
