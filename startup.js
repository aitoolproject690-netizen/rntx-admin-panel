const crypto = require("crypto");

// Replit/hosted previews can start without Secrets configured. Provide a
// strong temporary session secret so the application can boot instead of
// failing before it opens port 5000.
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = crypto.randomBytes(48).toString("hex");
}
if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = "ChangeMe123!";
}

require("./server-custom.js");
