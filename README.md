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
