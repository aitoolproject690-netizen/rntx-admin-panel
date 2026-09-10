# RNTX ADMIN PANEL

A starter license/key management panel for an app you control.

## Replit setup
1. Create a new Replit project and upload/extract these files.
2. In **Secrets**, set:
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET` (use a long random value)
3. Run `npm install`.
4. Run `npm start`.
5. Open the Replit web preview.

## Features
- Dark neon responsive UI
- Admin login
- Random license generation
- Lifetime or timed licenses
- Device limits
- Key activation API for your APK
- Block/unblock/delete keys
- Reseller accounts
- Reseller panel expiry
- Referral relationships
- Dashboard statistics

## APK API
POST `/api/activate`

JSON:
{
  "licenseKey": "RNTX-...",
  "deviceId": "your-app-generated-device-id"
}

A successful response contains `valid: true` and the license information.

## Production notes
- Put the app behind HTTPS.
- Use a strong `SESSION_SECRET`.
- Do not hard-code admin credentials.
- Add rate limiting and audit logs before public launch.
- For real panel sales, connect a payment provider and verify webhooks server-side.

## Local preparation update (September 2026)
- Added a premium mobile-friendly login screen using the supplied comic artwork as the login background.
- Added glass-style login card, password visibility toggle, focus states, and accessible login feedback.
- Fixed the frontend so a missing optional brand-role element cannot crash the dashboard.
- Added an Admin-only Audit Logs screen backed by the existing audit-log API.
- Enforced Admin-only license block/unblock/delete operations on the server and reflected that restriction in the reseller UI.
- The supplied login artwork is stored as `public/login-background.jpg`.

The deployable archive intentionally excludes the local SQLite database and transient/editor metadata. Configure production secrets before deployment.
