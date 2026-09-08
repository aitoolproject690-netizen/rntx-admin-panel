---
name: RNTX access boundaries
description: Durable separation rules for the RNTX admin/reseller panel and APK verification API.
---

Panel expiry controls only reseller-panel access. Wallet balance controls purchases. A reseller's maximum device limit controls the largest device limit they may assign. Each license stores and enforces its own device limit and license duration. The APK activation endpoint remains independent of both browser panels.

**Why:** Expiring or blocking a reseller panel must not invalidate already-issued licenses, erase wallet history, or change the license rules used by the APK.

**How to apply:** Keep admin-only operations behind server-side role checks, scope reseller reads to the current reseller, and keep `/api/activate` unauthenticated by panel session while enforcing the license's own status, expiry, and device authorization rules.

Reseller account management is restricted to the primary admin account: credential changes, panel status, wallet edits, pricing changes, and deletion must all pass the same server-side primary-admin authorization boundary.

**Why:** Hiding controls in the browser is insufficient; reseller sessions must receive 403 responses even when they call management endpoints directly.

**How to apply:** Treat reseller-management endpoints as administrative mutations, record them in the audit log, and keep destructive deletion explicit and irreversible.