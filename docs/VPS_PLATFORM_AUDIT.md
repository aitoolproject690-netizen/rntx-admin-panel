# VPS platform audit — current repository baseline

## Scope and provenance

The current GitHub main branch at audit time was commit 2af9aec56490b3728616bd45f2ec2a38c55ea4b5 in aitoolproject690-netizen/rntx-admin-panel. The attached Replit workspace reported commit a8b7d569e30f18794fb7c7cb92369ac6de37cd2f and did not contain several files present on GitHub main (including persistence-start.js and the current owner/reseller UI assets). The GitHub main branch is treated as the source of truth for this audit; the attached workspace must be refreshed before it is used for a release.

The repository's README identifies this application as an RNTX license/key and reseller administration panel. Its current data model has users, keys, devices, pricing_plans, pricing_tiers, orders, transactions, audit_logs, settings, customer_panels and reseller_branding; it contains no VPS/VM, host, storage-pool, volume, network, address-allocation, support-ticket, invoice, payment-provider, or API-key schema.

## Existing feature inventory

| Area | Verified repository state | VPS-platform status |
|---|---|---|
| Admin/reseller sign-in | Password-based login with bcrypt, role checks, session regeneration, and primary-admin middleware exist. Registration and password reset do not. | BLOCKED — no customer account lifecycle |
| Sessions | The server wrapper installs a SQLite-backed Express session store. | IMPLEMENTED for the legacy panel only; not a VPS customer auth system |
| User and permissions | Primary admin can manage reseller accounts and balances; reseller key reads are owner-scoped. | PARTIAL — no tenant model or VPS authorization boundaries |
| Plans and quotas | Duration/device-count pricing, reseller wallet debits, and per-license device limits exist. | BLOCKED — no CPU/RAM/disk/traffic plans or quota accounting |
| Customer VPS lifecycle | No host registration, scheduler, VM state machine, console, rebuild, lifecycle queue, or libvirt integration found. | NOT CONNECTED |
| Storage | No pool, volume, snapshot, backup, restore, or disk-discovery implementation found. | NOT CONNECTED |
| Networking | No private network, DHCP/IPAM, firewall integration, public routing, or traffic accounting found. | NOT CONNECTED |
| Billing and support | Manual reseller wallet credits/debits exist. No payment gateway/webhook, customer invoices, support tickets, or notification service found. | BLOCKED |
| API keys | No scoped customer API-key creation, quotas, or revocation found. | BLOCKED |
| Database and migrations | SQLite is the application database; schema changes are performed at startup with CREATE TABLE IF NOT EXISTS and ad-hoc ALTER TABLE checks. PostgreSQL is used by the start wrapper for compressed copies of SQLite files, not as the normalized application database. | PARTIAL; not a VPS production schema/migration system |
| Persistence and recovery | Startup and server wrapper attempt snapshots to PostgreSQL. Snapshots copy SQLite files directly; restore and backup verification are not a tested recovery process. | BLOCKED for production recovery guarantees |
| Audit and rate limiting | Audit rows exist; login/activation throttles are in-process memory. | PARTIAL; no distributed quota/rate-limit system |
| UI | An admin/reseller web interface and owner-management pages exist. | BLOCKED — no VPS customer/admin UI |
| Deployment | Node start wrapper, PM2/Nginx instructions, and Replit config exist. No production Docker Compose, Linux compute-host installer, upgrade/rollback system, or host diagnostics workflow was found. | BLOCKED |
| Tests and CI | No application test suite or CI workflow was present in the audited main tree. | BLOCKED |
| KVM preflight | This change adds a read-only prerequisite checker and simulated unit tests. | IMPLEMENTED; TESTED by unit fixtures; not LIVE against a KVM host |

## Security and operational findings requiring follow-up

- persistence-start.js and server-custom.js configure PostgreSQL with rejectUnauthorized: false. That disables certificate verification and must be replaced with explicit, operator-configurable TLS verification before production use.
- persistence-start.js copies SQLite database files with synchronous file reads on a timer while the application can write them. This is not a verified SQLite-consistent backup/restore mechanism; use SQLite's backup API or a coordinated checkpoint and test restores before relying on it.
- customer_panels.control_secret is stored in plaintext. The admin-controlled remote panel URL accepts HTTP and is fetched server-side with that secret; this creates cleartext-secret and SSRF exposure. Restrict destination URLs, require verified HTTPS, and move secrets to encrypted storage before public deployment.
- The rate-limit map is per process and cannot enforce a quota across multiple workers/hosts.
- The attached Replit snapshot and latest GitHub main differ. Do not deploy a mixture of those revisions or assume the Replit preview includes the current remote source.

## Exact status vocabulary

- IMPLEMENTED — corresponding code exists; this does not imply a successful real-host run.
- TESTED — an automated test was run and passed for the stated scope.
- LIVE — observed working on the actual operator-controlled infrastructure.
- BLOCKED — implementation or an operator prerequisite is missing.
- NOT CONNECTED — a real host/provider/network integration is not connected.

No KVM host, customer VPS, storage pool, public route, or external payment provider was available or queried during this audit. Therefore no platform feature is marked LIVE.

## Infrastructure still required

1. An operator-owned or leased x86_64 or aarch64 Linux compute host running Ubuntu 22.04/24.04 or Debian 12/13, with CPU virtualization extensions exposed, /dev/kvm accessible to the agent, QEMU, and a working system libvirt daemon. The new preflight checks these local prerequisites only.
2. VM capacity targets: number of guests, vCPU/RAM/disk per plan, allowed overcommit, image/snapshot reserve, and host-failure spare capacity. Until those are specified, a responsible CPU/RAM/disk size cannot be stated; do not infer it from this control-plane app's VPS recommendation for small web services.
3. Operator-selected storage devices/pools and independent backup destination. No existing disk should be formatted or repurposed without an explicit, reviewed operator action.
4. Public networking from an upstream provider/operator: routed IPv4/IPv6 prefixes or assigned addresses, gateway, reverse DNS where needed, and an isolated bridge/VLAN/firewall policy. None is configured by this repository; no public IP or internet reachability is claimed.
5. Region, electricity/colocation or cloud-host tariff, bandwidth commitment/overage, IPv4 pricing, backup retention, and capacity target. The repository and request do not identify a provider or region with verified prices, so there is no defensible operating-cost estimate yet. No server was purchased and no paid service was enabled.

## This change's boundary

The KVM preflight is a safe first building block, not a VPS product. It intentionally does not register hosts, send credentials, provision guests, manage storage, allocate IPs, or claim any of those features. Those modules need their own reviewed implementation and tests before they can be exposed to customers.
