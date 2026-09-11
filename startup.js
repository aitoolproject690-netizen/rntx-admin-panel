const crypto = require("crypto");
const {execFileSync} = require("child_process");

// Hosted Replit workspaces can retain native modules built by an older Node.js
// ABI. Rebuild better-sqlite3 before loading the application when that happens.
try {
  require("better-sqlite3");
} catch (err) {
  const message = String(err?.message || err);
  if (!message.includes("NODE_MODULE_VERSION") && !message.includes("was compiled against a different Node.js version")) {
    throw err;
  }
  console.log("Rebuilding better-sqlite3 for the current Node.js runtime...");
  execFileSync("npm", ["rebuild", "better-sqlite3"], {stdio: "inherit"});
  require("better-sqlite3");
}

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
