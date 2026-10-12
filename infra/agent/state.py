from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import sqlite3
import time
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Iterator


class StateConflict(RuntimeError):
    pass


class AgentState:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink() or (self.path.exists() and not self.path.is_file()):
            raise PermissionError("agent database path must be a regular non-symlink file")
        if self.path.parent.stat().st_mode & 0o077:
            raise PermissionError("agent state directory must be private (mode 0700)")
        old_umask = os.umask(0o077)
        try:
            self._init()
        finally:
            os.umask(old_umask)
        if self.path.exists():
            self.path.chmod(0o600)

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        return db

    def _init(self) -> None:
        with closing(self.connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS vms (
                    vm_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, domain TEXT NOT NULL UNIQUE,
                    vcpus INTEGER NOT NULL, memory_mib INTEGER NOT NULL, disk_gib INTEGER NOT NULL,
                    mac TEXT NOT NULL UNIQUE, ip TEXT, status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS ip_leases (
                    ip TEXT PRIMARY KEY, network TEXT NOT NULL, vm_id TEXT NOT NULL UNIQUE,
                    tenant_id TEXT NOT NULL, mac TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS idempotency (
                    key TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL,
                    response TEXT, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    principal TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT,
                    result TEXT NOT NULL, detail TEXT
                );
            """)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def reserve_vm(self, values: dict, total_vcpu: int, total_memory_mib: int, reserve_cpu: int, reserve_memory_mib: int) -> None:
        with self.transaction() as db:
            row = db.execute("SELECT COALESCE(SUM(vcpus),0) AS c, COALESCE(SUM(memory_mib),0) AS m FROM vms WHERE status!='deleted'").fetchone()
            if row["c"] + values["vcpus"] > max(0, total_vcpu - reserve_cpu):
                raise StateConflict("CPU capacity or operator reserve would be exceeded")
            if row["m"] + values["memory_mib"] > max(0, total_memory_mib - reserve_memory_mib):
                raise StateConflict("memory capacity or operator reserve would be exceeded")
            db.execute("INSERT INTO vms(vm_id,tenant_id,domain,vcpus,memory_mib,disk_gib,mac,ip,status) VALUES(?,?,?,?,?,?,?,?,?)", (values["vm_id"], values["tenant_id"], values["domain"], values["vcpus"], values["memory_mib"], values["disk_gib"], values["mac"], values.get("ip"), "provisioning"))

    def vm(self, vm_id: str, tenant_id: str | None = None) -> dict | None:
        with closing(self.connect()) as db:
            row = db.execute("SELECT * FROM vms WHERE vm_id=? AND status!='deleted'" + (" AND tenant_id=?" if tenant_id is not None else ""), (vm_id, tenant_id) if tenant_id is not None else (vm_id,)).fetchone()
            return dict(row) if row else None

    def vms(self) -> list[dict]:
        with closing(self.connect()) as db:
            return [dict(row) for row in db.execute("SELECT * FROM vms WHERE status!='deleted' ORDER BY created_at")]

    def set_vm_status(self, vm_id: str, status: str, ip: str | None = None) -> None:
        with self.transaction() as db:
            if ip is None:
                db.execute("UPDATE vms SET status=? WHERE vm_id=?", (status, vm_id))
            else:
                db.execute("UPDATE vms SET status=?,ip=? WHERE vm_id=?", (status, ip, vm_id))

    def tenant_vm(self, vm_id: str, tenant_id: str) -> dict | None:
        return self.vm(vm_id, tenant_id)

    def vm_id_seen(self, vm_id: str) -> bool:
        with closing(self.connect()) as db:
            return db.execute("SELECT 1 FROM vms WHERE vm_id=?", (vm_id,)).fetchone() is not None

    def set_vm_disk_size(self, vm_id: str, disk_gib: int) -> None:
        with self.transaction() as db:
            db.execute("UPDATE vms SET disk_gib=? WHERE vm_id=?", (disk_gib, vm_id))

    def allocate_ip(self, network: str, cidr, gateway, start, end, vm_id: str, tenant_id: str, mac: str) -> str:
        with self.transaction() as db:
            existing = db.execute("SELECT ip,status,tenant_id,mac,network FROM ip_leases WHERE vm_id=?", (vm_id,)).fetchone()
            if existing:
                if existing["status"] == "released":
                    raise StateConflict("released VM identifiers cannot be reused")
                if existing["tenant_id"] != tenant_id or existing["mac"].lower() != mac.lower() or existing["network"] != network:
                    raise StateConflict("existing IP lease identity does not match this tenant, MAC, and network")
                if type(start)(int(existing["ip"])) not in cidr or not int(start) <= int(ipaddress.ip_address(existing["ip"])) <= int(end):
                    raise StateConflict("existing IP lease is outside the configured private DHCP range")
                return existing["ip"]
            used = {row[0] for row in db.execute("SELECT ip FROM ip_leases WHERE network=? AND status!='released'", (network,))}
            candidate = int(start)
            while candidate <= int(end):
                address = type(start)(candidate)
                if address in cidr and address != gateway and str(address) not in used:
                    ip = str(address)
                    prior = db.execute("SELECT status FROM ip_leases WHERE ip=?", (ip,)).fetchone()
                    if prior and prior["status"] == "released":
                        db.execute("UPDATE ip_leases SET network=?,vm_id=?,tenant_id=?,mac=?,status='pending',created_at=CURRENT_TIMESTAMP WHERE ip=? AND status='released'", (network, vm_id, tenant_id, mac, ip))
                    elif prior:
                        candidate += 1
                        continue
                    else:
                        db.execute("INSERT INTO ip_leases(ip,network,vm_id,tenant_id,mac,status) VALUES(?,?,?,?,?,'pending')", (ip, network, vm_id, tenant_id, mac))
                    return ip
                candidate += 1
            raise StateConflict("configured private DHCP range is exhausted")

    def set_lease_status(self, vm_id: str, status: str) -> None:
        with self.transaction() as db:
            db.execute("UPDATE ip_leases SET status=? WHERE vm_id=?", (status, vm_id))

    def release_lease(self, vm_id: str) -> None:
        with self.transaction() as db:
            db.execute("UPDATE ip_leases SET status='released' WHERE vm_id=?", (vm_id,))

    def leases(self) -> list[dict]:
        with closing(self.connect()) as db:
            return [dict(r) for r in db.execute("SELECT * FROM ip_leases WHERE status!='released' ORDER BY ip")]

    def idempotency_begin(self, key: str, method: str, path: str, body: bytes) -> tuple[str, dict | None]:
        digest = hashlib.sha256(method.encode() + b"\n" + path.encode() + b"\n" + body).hexdigest()
        with self.transaction() as db:
            db.execute("DELETE FROM idempotency WHERE created_at<? AND status='complete'", (time.time() - 86400,))
            row = db.execute("SELECT digest,status,response FROM idempotency WHERE key=?", (key,)).fetchone()
            if row:
                if row["digest"] != digest:
                    raise StateConflict("Idempotency-Key was already used with a different request")
                if row["status"] == "complete":
                    return digest, json.loads(row["response"])
                raise StateConflict("request with this Idempotency-Key is already in progress")
            db.execute("INSERT INTO idempotency(key,digest,status,created_at) VALUES(?,?,'processing',?)", (key, digest, time.time()))
        return digest, None

    def idempotency_finish(self, key: str, digest: str, response: dict) -> None:
        with self.transaction() as db:
            db.execute("UPDATE idempotency SET status='complete',response=? WHERE key=? AND digest=?", (json.dumps(response, separators=(",", ":")), key, digest))

    def audit(self, principal: str, action: str, resource_id: str | None, result: str, detail: str = "") -> None:
        with self.transaction() as db:
            db.execute("INSERT INTO audit(principal,action,resource_id,result,detail) VALUES(?,?,?,?,?)", (principal[:128], action[:128], (resource_id or "")[:128], result[:32], detail[:400]))

    def recent_audit(self, limit: int = 100) -> list[dict]:
        with closing(self.connect()) as db:
            return [dict(r) for r in db.execute("SELECT id,at,principal,action,resource_id,result,detail FROM audit ORDER BY id DESC LIMIT ?", (max(1, min(limit, 500)),))]
