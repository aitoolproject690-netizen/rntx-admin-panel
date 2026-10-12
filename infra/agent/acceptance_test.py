#!/usr/bin/env python3
"""Opt-in real-host acceptance checks for the self-hosted VPS host agent."""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class AgentClient:
    def __init__(self, base_url: str, ca: str, cert: str, key: str):
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("VPS_AGENT_URL must be an HTTPS origin without embedded credentials")
        self.base_url = base_url.rstrip("/")
        self.context = ssl.create_default_context(cafile=ca)
        self.context.minimum_version = ssl.TLSVersion.TLSv1_2
        self.context.load_cert_chain(certfile=cert, keyfile=key)

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
            headers["Idempotency-Key"] = str(uuid.uuid4())
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, context=self.context, timeout=300) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise RuntimeError("agent response exceeded the 1 MiB acceptance-test limit")
                result = json.loads(raw.decode("utf-8"))
                if not isinstance(result, dict):
                    raise RuntimeError("agent returned a non-object response")
                return result
        except urllib.error.HTTPError as exc:
            raw = exc.read(16 * 1024).decode("utf-8", errors="replace")
            raise RuntimeError(f"agent {method} {path} returned HTTP {exc.code}: {raw}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"agent connection failed: {exc.reason}") from exc


def required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise ValueError(f"set {name} to the operator-provisioned local path/URL")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-vm-lifecycle", action="store_true", help="explicitly create, gracefully stop, and delete one generated acceptance VM")
    parser.add_argument("--image", help="configured cloud-init qcow2 filename; required with --run-vm-lifecycle")
    parser.add_argument("--ssh-public-key-file", help="path to a test VM SSH public key; required with --run-vm-lifecycle")
    parser.add_argument("--tenant-id", default="host-acceptance")
    parser.add_argument("--vcpus", type=int, default=1)
    parser.add_argument("--memory-mib", type=int, default=1024)
    parser.add_argument("--disk-gib", type=int, default=8)
    args = parser.parse_args()

    try:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}", args.tenant_id):
            raise ValueError("--tenant-id has an invalid format")
        client = AgentClient(required_env("VPS_AGENT_URL"), required_env("VPS_AGENT_CA"), required_env("VPS_AGENT_CLIENT_CERT"), required_env("VPS_AGENT_CLIENT_KEY"))
        health = client.call("GET", "/v1/health")
        capabilities = client.call("GET", "/v1/capabilities")
        host = client.call("GET", "/v1/host")
        storage = client.call("GET", "/v1/storage/volumes")
        network = client.call("GET", "/v1/network")
        if health.get("status") != "ok" or host.get("status") != "CONNECTED":
            raise RuntimeError("agent/libvirt host is not ready; inspect /v1/health and /v1/host")
        if storage.get("capacity", {}).get("available", 0) <= 0 or storage.get("capacity", {}).get("capacity", 0) <= 0:
            raise RuntimeError("configured storage pool has no verifiable free capacity")
        if network.get("private", {}).get("status") != "CONNECTED":
            raise RuntimeError("configured private libvirt network is not connected")
        report = {
            "acceptance": "PASSED_READ_ONLY_CHECKS",
            "host_id": host.get("host_id"),
            "host_status": host.get("status"),
            "cpu_threads": host.get("cpu_threads"),
            "memory_mib": host.get("memory_mib"),
            "storage_capacity": storage.get("capacity"),
            "private_network": network.get("private"),
            "public_network": network.get("public"),
            "vm_lifecycle": "NOT RUN; pass --run-vm-lifecycle to create and then clean up a test VM",
        }
        if args.run_vm_lifecycle:
            if not args.image or not args.ssh_public_key_file:
                raise ValueError("--image and --ssh-public-key-file are required with --run-vm-lifecycle")
            with open(args.ssh_public_key_file, "r", encoding="utf-8") as key_file:
                ssh_public_key = key_file.read().strip()
            vm_id = str(uuid.uuid4())
            vm_path = "/v1/vms/" + vm_id
            query = "?tenant_id=" + urllib.parse.quote(args.tenant_id, safe="")
            provisioned = False
            try:
                created = client.call("POST", "/v1/vms", {
                    "vm_id": vm_id,
                    "tenant_id": args.tenant_id,
                    "image": args.image,
                    "vcpus": args.vcpus,
                    "memory_mib": args.memory_mib,
                    "disk_gib": args.disk_gib,
                    "hostname": "host-acceptance-" + vm_id[:8],
                    "username": "ubuntu",
                    "ssh_public_key": ssh_public_key,
                })
                provisioned = created.get("status") == "running"
                if not provisioned or created.get("public_ipv4") is not None:
                    raise RuntimeError("host agent did not confirm the expected private-only running state")
                observed = client.call("GET", vm_path + query)
                if observed.get("status") != "running":
                    raise RuntimeError("GET did not confirm the test VM is running")
                stopped = client.call("POST", vm_path + "/shutdown", {"tenant_id": args.tenant_id})
                if stopped.get("status") not in {"shut off", "shutoff"}:
                    raise RuntimeError("graceful shutdown did not reach a confirmed shut-off state")
                deleted = client.call("DELETE", vm_path, {"tenant_id": args.tenant_id})
                if deleted.get("status") != "deleted":
                    raise RuntimeError("test VM deletion was not confirmed")
                report["vm_lifecycle"] = "PASSED: provisioned, confirmed running, gracefully shut down, and deleted its own generated VM"
            except Exception:
                if provisioned:
                    print(f"Acceptance VM {vm_id} may remain. The test will not force-stop it; inspect its state before manual cleanup.", file=sys.stderr)
                else:
                    print(f"Provision request did not confirm success. Inspect host state for generated VM ID {vm_id} before cleanup.", file=sys.stderr)
                raise
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(f"ACCEPTANCE BLOCKED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
