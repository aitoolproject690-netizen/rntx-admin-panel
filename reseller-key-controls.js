// Adds reseller-owned license key block/unblock without changing admin controls.
const express = require("express");
const Database = require("better-sqlite3");

const originalPatch = express.application.patch;

express.application.patch = function(routePath, ...handlers) {
  if (routePath === "/api/keys/:id" && handlers.length >= 2) {
    const originalAdminOnly = handlers[0];
    const originalHandler = handlers[handlers.length - 1];
    handlers[0] = function(req, res, next) {
      const sessionUser = req.session?.user;
      if (sessionUser?.role !== "reseller") return originalAdminOnly(req, res, next);

      const db = new Database("rntx.db");
      try {
        const user = db.prepare("SELECT id,username,role,active,panel_expires_at FROM users WHERE id=?").get(sessionUser.id);
        if (!user || user.role !== "reseller" || !user.active) return res.status(403).json({error:"Panel blocked",code:"PANEL_BLOCKED"});
        if (user.panel_expires_at && new Date(user.panel_expires_at) <= new Date()) return res.status(403).json({error:"Reseller panel access has expired",code:"PANEL_EXPIRED"});

        const key = db.prepare("SELECT id,owner_id FROM keys WHERE id=?").get(req.params.id);
        if (!key) return res.status(404).json({error:"Key not found"});
        if (Number(key.owner_id) !== Number(user.id)) return res.status(403).json({error:"You can only manage your own license keys"});

        req.currentUser = user;
        return originalHandler(req, res, next);
      } finally {
        db.close();
      }
    };
  }
  return originalPatch.call(this, routePath, ...handlers);
};

require("./server-custom.js");
