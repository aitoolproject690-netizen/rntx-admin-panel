#!/usr/bin/env python3
"""Read-only KVM/libvirt readiness probe. This never installs or changes anything."""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path
from typing import Mapping

SUPPORTED_OS = {
    "ubuntu": {"22.04", "24.04"},
    "debian": {"12", "13"},
}
ARCHITECTURES = {
    "x86_64": ("qemu-system-x86_64", {"vmx", "svm"}),
    "aarch64": ("qemu-system-aarch64", {"virt"}),
}


def parse_os_release(text: str) -> dict[str, str]:
    """Parse the KEY=VALUE subset of os-release without evaluating shell code."""
    import shlex

    result: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Z0-9_]+", key):
            try:
                result[key] = shlex.split(value, comments=False, posix=True)[0]
            except (ValueError, IndexError):
                result[key] = value.strip().strip("\\\"'")
    return result


def _check(passed: bool, detail: str) -> dict[str, str]:
    return {"status": "PASS" if passed else "FAIL", "detail": detail}


def assess(
    *,
    system_name: str,
    architecture: str,
    os_release: Mapping[str, str],
    cpuinfo: str,
    kvm_exists: bool,
    kvm_read_write: bool,
    qemu_binary: str | None,
    virsh_binary: str | None,
    libvirt_connected: bool,
    libvirt_error: str = "",
) -> dict[str, object]:
    """Turn read-only probe results into explicit capabilities and blockers."""
    os_id = str(os_release.get("ID", "")).lower()
    version = str(os_release.get("VERSION_ID", ""))
    os_supported = version in SUPPORTED_OS.get(os_id, set())
    arch = architecture.lower()
    if arch in {"amd64", "x64"}:
        arch = "x86_64"
    elif arch in {"arm64", "armv8l"}:
        arch = "aarch64"
    arch_config = ARCHITECTURES.get(arch)

    flags: set[str] = set()
    for line in cpuinfo.splitlines():
        name, separator, value = line.partition(":")
        if separator and name.strip().lower() in {"flags", "features"}:
            flags.update(value.lower().split())
    cpu_flags = arch_config[1] if arch_config else set()
    has_virtualization = bool(flags & cpu_flags)

    checks = {
        "linux": _check(system_name == "Linux", "Linux host detected." if system_name == "Linux" else "A Linux host is required."),
        "supported_os": _check(os_supported, f"{os_id or 'unknown'} {version or 'unknown'}; supported: Ubuntu 22.04/24.04 or Debian 12/13."),
        "supported_architecture": _check(arch_config is not None, f"{arch}; supported architectures: x86_64 and aarch64."),
        "cpu_virtualization": _check(has_virtualization, "CPU virtualization flags detected." if has_virtualization else "Required VT-x/AMD-V or ARM virtualization CPU flag was not detected."),
        "kvm_device": _check(kvm_exists and kvm_read_write, "/dev/kvm exists and is readable/writable." if kvm_exists and kvm_read_write else ("/dev/kvm exists but is not accessible to this user." if kvm_exists else "/dev/kvm is not present; KVM is unavailable or not exposed to this host.")),
        "qemu": _check(bool(qemu_binary), f"Found {qemu_binary}." if qemu_binary else f"Required QEMU binary {arch_config[0] if arch_config else '(unsupported architecture)'} was not found."),
        "libvirt": _check(bool(virsh_binary and libvirt_connected), "Connected to the local qemu:///system libvirt daemon using a read-only query." if virsh_binary and libvirt_connected else (f"Local libvirt query failed: {libvirt_error[:200]}" if libvirt_error else "virsh or the qemu:///system libvirt service is unavailable.")),
    }
    ready = all(check["status"] == "PASS" for check in checks.values())
    return {
        "schema_version": 1,
        "host_preflight": "READY" if ready else "BLOCKED",
        "host": {"os_id": os_id or None, "os_version": version or None, "architecture": arch},
        "checks": checks,
        "integrations": {
            "local_libvirt": "CONNECTED" if virsh_binary and libvirt_connected else "NOT CONNECTED",
            "control_plane": "NOT CONNECTED",
            "host_agent": "NOT IMPLEMENTED",
            "vm_provisioning": "NOT CONNECTED",
            "storage_pools": "NOT CONNECTED",
            "public_network": "NOT CONNECTED",
        },
        "read_only": True,
        "message": "A READY result only means this host passed local KVM/libvirt checks; it does not mean a control plane, storage pool, VM, public IP, or network is configured.",
    }


def _run_read_only(argv: list[str]) -> tuple[bool, str]:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)[:200]
    if result.returncode == 0:
        return True, ""
    return False, (result.stderr or result.stdout or f"exit {result.returncode}").strip()[:200]


def collect() -> dict[str, object]:
    """Collect only local, read-only operating-system and libvirt signals."""
    try:
        os_release = parse_os_release(Path("/etc/os-release").read_text(encoding="utf-8"))
    except OSError:
        os_release = {}
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace")
    except OSError:
        cpuinfo = ""

    architecture = platform.machine()
    arch_key = architecture.lower()
    if arch_key in {"amd64", "x64"}:
        arch_key = "x86_64"
    elif arch_key in {"arm64", "armv8l"}:
        arch_key = "aarch64"
    arch_config = ARCHITECTURES.get(arch_key)
    qemu_binary = shutil.which(arch_config[0]) if arch_config else None
    virsh_binary = shutil.which("virsh")
    kvm_exists = os.path.exists("/dev/kvm")
    kvm_read_write = kvm_exists and os.access("/dev/kvm", os.R_OK | os.W_OK)
    connected, error = _run_read_only([virsh_binary, "--readonly", "-c", "qemu:///system", "nodeinfo"]) if virsh_binary else (False, "virsh was not found")
    return assess(
        system_name=platform.system(),
        architecture=architecture,
        os_release=os_release,
        cpuinfo=cpuinfo,
        kvm_exists=kvm_exists,
        kvm_read_write=kvm_read_write,
        qemu_binary=qemu_binary,
        virsh_binary=virsh_binary,
        libvirt_connected=connected,
        libvirt_error=error,
    )


def main() -> int:
    report = collect()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["host_preflight"] == "READY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
