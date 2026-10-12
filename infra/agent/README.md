# Self-hosted KVM host agent

This is a separate Python 3.10+ service for an operator-managed Linux hypervisor. It uses Python's standard library and host commands installed by the operator. It does not expose a customer shell, install host packages, format disks, download cloud images, or guess addresses. It is not connected to the existing RNTX web app: that app has no VPS controller/client, tenant VPS schema, or host-enrollment flow. A trusted control plane must call this API over mTLS before customers can use it.

## Implemented behavior and hard boundaries

- HTTPS listener with mandatory TLS 1.2+ and client-certificate validation against an operator CA; exact control-plane certificate CN allowlist; default bind is loopback. No bearer-password endpoint.
- 60 requests/minute per authenticated controller certificate, 128 KiB JSON limit, duplicate JSON-key rejection, required UUID Idempotency-Key on every mutation, 24-hour completed-key retention, SQLite WAL state with mode-0600 DB/private mode-0700 state directory, and local mutation audit records.
- Real local virsh -c qemu:///system lifecycle calls. Provisioning verifies a read-only qcow2 base image, checks per-VM and aggregate CPU/RAM against libvirt inventory (including non-agent domains), creates volumes through the configured libvirt pool, uploads qemu-img and cloud-init artifacts through libvirt, defines/starts the VM, and reports running only after domstate confirms it. Failures return errors; uncertain resources are retained and marked failed if cleanup cannot be proven safe.
- Only a pre-existing libvirt directory pool at the exact configured dedicated path is allowed. Capacity is checked before volume creation. Delete refuses any domain reference and fails closed if any domain XML cannot be inspected. Resize is grow-only and requires a shut-off VM. The agent never partitions/formats block devices or creates a storage pool.
- Private IPv4 NAT networking only. The agent can optionally define/start the exact configured libvirt network when VPS_AGENT_ALLOW_NETWORK_CREATE=true; default is false. DHCP reservations are persisted in the IPAM database and applied through virsh net-update. A reservation is not marked active until libvirt accepts it.
- Public IPv4/IPv6 routing, public IPs, upstream-provider APIs, traffic accounting, snapshots/backups, separate storage nodes, scheduler/host registration, and control-plane integration are NOT CONNECTED / NOT IMPLEMENTED. Public-IP allocation returns an explicit 501; API responses never invent a public address.
- Operations are synchronous in this initial host-local agent; the existing app does not submit asynchronous jobs to it.

The host agent is privileged infrastructure software even when run as a non-root user: access to the libvirt system socket can control the host's VMs. Isolate it on a management network, protect its client CA, keep its client certificate private, expose it only to the control plane, and rotate certificates by issuing a new certificate and restarting the service. Do not issue the agent client certificate to a customer.

## Supported host and guest prerequisites

- Ubuntu 22.04/24.04 or Debian 12/13; Python 3.10+; x86_64 (Intel VT-x or AMD-V) or aarch64 with hardware virtualization exposed.
- /dev/kvm accessible to QEMU, architecture-matching qemu-system binary, qemu-img, virsh, system libvirt at qemu:///system, cloud-localds from cloud-image-utils, and iproute2 for the host-route overlap guard used when an explicitly enabled private network is created.
- Guest image must be a trusted, cloud-init-enabled qcow2 image matching host architecture. The agent does not download images. Store it directly in the configured image directory and make it read-only with chmod 0444. Set the guest's login account with request username if it is not ubuntu.
- The existing RNTX app does not register hosts or provide customer-facing plans, VPS pages, job orchestration, or tenant billing. This service alone is not a hosting product.

## Install on a real host

No command in this section was run against production infrastructure.

1. Run the existing read-only probe from repository root: python3 infra/kvm/preflight.py. READY proves only local KVM/libvirt prerequisites; it does not register the node or prove public connectivity.
2. Install distribution QEMU/libvirt/cloud-image utilities with its package manager. Typical Debian/Ubuntu packages are qemu-kvm, qemu-utils, libvirt-daemon-system, libvirt-clients, and cloud-image-utils. This repository does not run apt, load modules, or change firmware settings.
3. Create a dedicated, empty directory pool path only after confirming it is new and not a mount containing customer data. Example path: /var/lib/libvirt/images/vps-agent-pool. Define/start a dir pool with virsh -c qemu:///system pool-define-as vps-agent-pool dir --target /var/lib/libvirt/images/vps-agent-pool, then run pool-start and pool-autostart. Do not point it at a disk device or an existing pool with unrelated data. The agent verifies pool type and exact path; it never defines/formats storage.
4. Place a verified cloud-init qcow2 image under /usr/local/share/vps-cloud-images, verify its upstream checksum and architecture, and make it read-only. Images must include cloud-init; test them on a disposable VM first.
5. Create a dedicated system user with no login shell and grant only the group required for access to the local libvirt socket (commonly libvirt). Provision the TLS server certificate and separate control-plane client CA/certificate through your PKI. The server certificate SAN must match the DNS name/IP used by the controller. Keep the CA private key off the hypervisor. The server private key must be mode 0600. No certificates or keys are included here.
6. Copy agent.env.example to /etc/vps-agent/agent.env, update the paths, host ID, CIDR, pool, and trusted controller CN; set root ownership and mode 0600. Ensure the private CIDR is unused and does not overlap host, VPN, tenant, or upstream routes. The default bind is 127.0.0.1; for remote controller access use a private/VPN address and restrict firewall ingress to that plane. Never expose port 9443 to the public internet.
7. Review systemd/vps-host-agent.service and adjust WorkingDirectory if the checkout is not /opt/rntx-admin-panel. Install the unit, run systemctl daemon-reload, enable/start it. The unit is hardened and runs without root or sudo. If libvirt socket access fails, the host remains blocked; do not broaden permissions blindly.
8. Leave VPS_AGENT_ALLOW_NETWORK_CREATE=false unless the operator reviewed the exact private CIDR and bridge and explicitly wants this service to create/start the private NAT network during provisioning. The agent never creates a public bridge or changes upstream routes.
9. Query /v1/host, /v1/storage/volumes, and /v1/network using the control-plane certificate. Blocked responses are real failures, not successful installation. The current RNTX web app has no caller integration.

The example values in agent.env.example are non-secret placeholders. VPS_AGENT_STORAGE_PATH must equal the libvirt pool target path. Agent state directory must be private. The sample CIDR is not guaranteed to be unused; check for overlap before use.

## API

All routes require a client certificate signed by VPS_AGENT_CLIENT_CA whose common name exactly matches VPS_AGENT_CONTROLLER_CN. Customer browsers are not clients; the controller must enforce tenant authorization before sending requests. Mutations require Idempotency-Key with a UUID.

- GET /v1/health: process health only, not host readiness.
- GET /v1/capabilities: implemented and not-connected capability flags.
- GET /v1/host: checked libvirt CPU/RAM inventory, allocation estimates, storage and private-network status.
- GET /v1/storage/volumes: managed-volume list and verified pool capacity.
- GET /v1/network: read-only private-network status; never creates or starts a network.
- GET /v1/audit?limit=100: recent local audit events, up to 500.
- POST /v1/vms: real provision request with vm_id UUID, tenant_id, image filename, vcpus, memory_mib, disk_gib, ssh_public_key; optional hostname and username.
- GET /v1/vms/{uuid}?tenant_id=...: state only for the tenant ID supplied by the trusted controller.
- POST /v1/vms/{uuid}/start, /shutdown, /reboot: checked lifecycle calls; shutdown is graceful only.
- POST /v1/vms/{uuid}/disk/resize: grow-only disk resize while shut off; guest partition/filesystem growth is not performed.
- DELETE /v1/vms/{uuid}: JSON body must include tenant_id; VM must be shut off; active/attached disks are never force-deleted.
- POST /v1/network/public/allocate: returns 501 PUBLIC_NETWORK_NOT_CONNECTED; no public IP is assigned.

Example authenticated probe: curl --cacert control-plane-ca.crt --cert controller.crt --key controller.key https://host-agent.internal:9443/v1/host

The control-plane client protocol is not implemented in server.js or server-custom.js, so this API cannot yet be reached from the existing customer/admin UI.

## Tests, backup, restore, upgrade, recovery

From repository root on Python 3.10+:

    python3 -m compileall -q infra/agent infra/kvm
    python3 -m unittest discover -s infra/agent/tests -v
    python3 -m unittest discover -s infra/kvm/tests -v

Agent tests use isolated temporary SQLite databases and explicit command/network/storage doubles. They validate control decisions and error handling; they do not emulate a working KVM host or prove hardware success. Real-host acceptance requires an operator-provided compatible host and cloud image. The read-only and opt-in lifecycle checks are in infra/agent/acceptance_test.py. Set VPS_AGENT_URL, VPS_AGENT_CA, VPS_AGENT_CLIENT_CERT, and VPS_AGENT_CLIENT_KEY locally to the HTTPS URL and protected certificate paths; these are never committed. Run python3 infra/agent/acceptance_test.py for read-only checks. To explicitly create and clean up one test VM, also pass --run-vm-lifecycle --image <configured-cloud-init.qcow2> --ssh-public-key-file <test-key.pub> --tenant-id host-acceptance. It never force-stops a VM; if a step is uncertain, it prints the generated VM ID for operator inspection.

Back up the agent SQLite state using SQLite's online backup API and keep it encrypted/off-host. The example below copies a live database consistently; replace both paths with operator-approved locations and protect the destination:

    python3 - <<'PY'
    import sqlite3
    from datetime import date
    source = sqlite3.connect("file:/var/lib/vps-agent/agent.sqlite3?mode=ro", uri=True)
    destination = sqlite3.connect("/secure-backups/vps-agent-" + date.today().isoformat() + ".sqlite3")
    source.backup(destination)
    assert destination.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    destination.close()
    source.close()
    PY

That backup contains agent metadata/IP allocations only, not guest disks. Independently back up VM volumes with an operator-reviewed hypervisor/storage backup solution; this agent has no snapshot/backup workflow. Restore only with the service stopped, run PRAGMA integrity_check, then reconcile stored VM/IP records with virsh domains, domain XML and pool volumes before re-enabling requests. Never delete disks just because metadata is missing.

Upgrade by backing up state, pinning the current Git ref, stopping the unit, updating the checkout, compiling/running tests, and restarting; inspect /v1/host and systemd logs. Keep the old ref for rollback. Roll back code to the pinned ref and restart. Do not blindly restore an old database over newer libvirt state; reconcile domains, volumes and leases first. No automated agent-schema migration is provided.

On libvirt/network/storage errors, API responses report failure and uncertain resources stay reserved for operator inspection. Review journalctl -u vps-host-agent, virsh domstate/list/pool-info/net-info, the SQLite audit and agent DB before manual cleanup. Never format a pool to recover it.

## Current blockers

No real host is connected or acceptance-tested; no host registration/scheduler or web control-plane integration exists; no public address range/upstream route is configured; no cross-node storage, snapshot/backup, traffic accounting, customer VPS billing or support flows are provided. Host size, region, bandwidth, public IPv4/IPv6 fees and power/colocation costs are operator-specific; this agent makes no cost or internet-reachability claim.
