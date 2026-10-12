from __future__ import annotations

import base64
import json
import platform
import re
import stat
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

from .config import Config
from .network import NetworkError, PrivateNetwork
from .runner import CommandError, CommandRunner
from .state import AgentState, StateConflict
from .storage import SafeStorage, StorageError

_TENANT = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")
_HOST = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$")
_USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


class BackendError(RuntimeError):
    def __init__(self, message: str, status: int = 409):
        self.status = status
        super().__init__(message)


def normalize_vm_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise BackendError("vm_id must be a UUID", 400) from exc


def validate_ssh_key(value: str) -> str:
    if not isinstance(value, str) or len(value) > 8192 or "\n" in value or "\r" in value:
        raise BackendError("one SSH public key is required", 400)
    parts = value.strip().split()
    allowed = {"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"}
    if len(parts) < 2 or parts[0] not in allowed:
        raise BackendError("unsupported SSH public key type", 400)
    try:
        key_data = base64.b64decode(parts[1], validate=True)
    except Exception as exc:
        raise BackendError("invalid SSH public key encoding", 400) from exc
    if len(key_data) < 4 or len(key_data) > 4096:
        raise BackendError("invalid SSH public key", 400)
    key_type_size = int.from_bytes(key_data[:4], "big")
    if key_type_size < 1 or key_type_size > len(key_data) - 4:
        raise BackendError("invalid SSH public key blob", 400)
    try:
        embedded_type = key_data[4:4 + key_type_size].decode("ascii")
    except UnicodeDecodeError as exc:
        raise BackendError("invalid SSH public key type", 400) from exc
    if embedded_type != parts[0]:
        raise BackendError("SSH public key type does not match its encoded key blob", 400)
    comment = " " + parts[2] if len(parts) > 2 else ""
    return parts[0] + " " + parts[1] + comment


class LibvirtBackend:
    """Real, checked libvirt/QEMU adapter. There are no successful fake fallbacks."""

    def __init__(self, config: Config, runner: CommandRunner, state: AgentState, storage: SafeStorage, network: PrivateNetwork):
        self.config, self.runner, self.state, self.storage, self.network = config, runner, state, storage, network
        self.uri = config.libvirt_uri

    def _virsh(self, *args: str) -> str:
        return self.runner.run("virsh", "-c", self.uri, *args)

    def _tenant(self, tenant_id: str) -> str:
        if not isinstance(tenant_id, str) or not _TENANT.fullmatch(tenant_id):
            raise BackendError("invalid tenant_id", 400)
        return tenant_id

    def _owned(self, vm_id: str, tenant_id: str) -> dict:
        vm_id = normalize_vm_id(vm_id)
        vm = self.state.tenant_vm(vm_id, self._tenant(tenant_id))
        if not vm:
            raise BackendError("VPS not found", 404)
        return vm

    def _capacity(self) -> tuple[int, int]:
        try:
            node = self._virsh("nodeinfo")
            fields = {}
            for line in node.splitlines():
                key, separator, value = line.partition(":")
                if separator:
                    fields[key.strip().lower()] = value.strip()
            cpus = int(fields.get("cpu(s)", "0"))
            memory_parts = fields.get("memory size", "").split()
            if len(memory_parts) != 2 or not memory_parts[0].isdigit():
                raise ValueError("libvirt nodeinfo memory is unavailable")
            amount, unit = int(memory_parts[0]), memory_parts[1].lower()
            divisors = {"kib": (1024, 1), "mib": (1, 1), "gib": (1, 1024)}
            divisor, multiplier = divisors.get(unit, (0, 0))
            if not cpus or not divisor:
                raise ValueError("libvirt nodeinfo resources are invalid")
            memory_mib = (amount * multiplier + divisor - 1) // divisor
            if memory_mib < 1:
                raise ValueError("libvirt nodeinfo memory is invalid")
            return cpus, memory_mib
        except (CommandError, ValueError) as exc:
            raise BackendError("libvirt host capacity could not be verified", 503) from exc

    def _external_reservations(self) -> tuple[int, int]:
        managed = {vm["domain"] for vm in self.state.vms()}
        names = self._virsh("list", "--all", "--name").splitlines()
        cpu_total = memory_total = 0
        for domain in filter(None, names):
            if domain in managed:
                continue
            try:
                root = ET.fromstring(self._virsh("dumpxml", domain))
                vcpu = root.findtext("vcpu")
                mem_node = root.find("memory")
                if not vcpu or mem_node is None or not mem_node.text:
                    raise ValueError("missing resource values")
                cpu_total += int(vcpu.strip())
                amount = int(mem_node.text.strip())
                unit = mem_node.attrib.get("unit", "KiB").lower()
                divisor, multiplier = {"b": (1024 * 1024, 1), "bytes": (1024 * 1024, 1), "kib": (1024, 1), "mib": (1, 1), "gib": (1, 1024), "tib": (1, 1024 * 1024)}.get(unit, (0, 0))
                if divisor == 0:
                    raise ValueError("unknown memory unit")
                memory_total += (amount * multiplier + divisor - 1) // divisor
            except (CommandError, ET.ParseError, TypeError, ValueError) as exc:
                raise BackendError("cannot verify resources for every existing libvirt domain", 503) from exc
        return cpu_total, memory_total

    def _image(self, name: str) -> Path:
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.qcow2", name):
            raise BackendError("image must be a configured .qcow2 filename, not a path", 400)
        root = self.config.image_path.resolve(strict=True)
        candidate = root / name
        if candidate.is_symlink():
            raise BackendError("symbolic-link cloud images are not accepted", 400)
        path = candidate.resolve(strict=True)
        if path.parent != root or not path.is_file():
            raise BackendError("cloud image must be a regular file directly under the configured image directory", 400)
        if path.stat().st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH):
            raise BackendError("base image must be read-only before it can be used", 409)
        try:
            info = json.loads(self.runner.run("qemu-img", "info", "--output=json", str(path)))
        except (CommandError, json.JSONDecodeError) as exc:
            raise BackendError("base image could not be verified as a usable QEMU image", 409) from exc
        if info.get("format") != "qcow2":
            raise BackendError("only qcow2 cloud images are supported", 400)
        return path

    @staticmethod
    def _mac(vm_id: str) -> str:
        raw = uuid.UUID(vm_id).bytes[-3:]
        return "52:54:00:" + ":".join(f"{part:02x}" for part in raw)

    def _user_data(self, hostname: str, username: str, ssh_key: str) -> str:
        return ("#cloud-config\n" f"hostname: {hostname}\n" "disable_root: true\n" "ssh_pwauth: false\n" "users:\n" f"  - name: {username}\n" "    groups: [sudo]\n" "    shell: /bin/bash\n" "    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n" "    ssh_authorized_keys:\n" f"      - {json.dumps(ssh_key)}\n")

    def _domain_xml(self, vm_id: str, memory_mib: int, vcpus: int, mac: str, root_volume: str, seed_volume: str) -> str:
        machine_arch = platform.machine().lower()
        if machine_arch in {"x86_64", "amd64", "x64"}:
            guest_arch, machine_type = "x86_64", "q35"
        elif machine_arch in {"aarch64", "arm64", "armv8l"}:
            guest_arch, machine_type = "aarch64", "virt"
        else:
            raise BackendError("unsupported host architecture for KVM guests", 503)
        root = ET.Element("domain", {"type": "kvm"})
        ET.SubElement(root, "name").text = "vps-" + vm_id
        ET.SubElement(root, "uuid").text = vm_id
        ET.SubElement(root, "memory", {"unit": "MiB"}).text = str(memory_mib)
        ET.SubElement(root, "currentMemory", {"unit": "MiB"}).text = str(memory_mib)
        ET.SubElement(root, "vcpu", {"placement": "static"}).text = str(vcpus)
        cpu = ET.SubElement(root, "cpu", {"mode": "host-passthrough", "check": "none"})
        ET.SubElement(cpu, "topology", {"sockets": "1", "dies": "1", "cores": str(vcpus), "threads": "1"})
        cputune = ET.SubElement(root, "cputune")
        ET.SubElement(cputune, "period").text = "100000"
        ET.SubElement(cputune, "quota").text = str(vcpus * 100000)
        os_node = ET.SubElement(root, "os")
        ET.SubElement(os_node, "type", {"arch": guest_arch, "machine": machine_type}).text = "hvm"
        ET.SubElement(os_node, "boot", {"dev": "hd"})
        features = ET.SubElement(root, "features")
        ET.SubElement(features, "acpi")
        ET.SubElement(features, "apic")
        ET.SubElement(root, "on_poweroff").text = "destroy"
        ET.SubElement(root, "on_reboot").text = "restart"
        ET.SubElement(root, "on_crash").text = "destroy"
        devices = ET.SubElement(root, "devices")
        disk = ET.SubElement(devices, "disk", {"type": "volume", "device": "disk"})
        ET.SubElement(disk, "driver", {"name": "qemu", "type": "qcow2"})
        ET.SubElement(disk, "source", {"pool": self.config.storage_pool, "volume": root_volume})
        ET.SubElement(disk, "target", {"dev": "vda", "bus": "virtio"})
        cd = ET.SubElement(devices, "disk", {"type": "volume", "device": "cdrom"})
        ET.SubElement(cd, "driver", {"name": "qemu", "type": "raw"})
        ET.SubElement(cd, "source", {"pool": self.config.storage_pool, "volume": seed_volume})
        ET.SubElement(cd, "target", {"dev": "sda", "bus": "sata"})
        ET.SubElement(cd, "readonly")
        interface = ET.SubElement(devices, "interface", {"type": "network"})
        ET.SubElement(interface, "mac", {"address": mac})
        ET.SubElement(interface, "source", {"network": self.config.private_network})
        ET.SubElement(interface, "model", {"type": "virtio"})
        ET.SubElement(devices, "serial", {"type": "pty"})
        ET.SubElement(devices, "console", {"type": "pty"})
        return ET.tostring(root, encoding="unicode")

    def provision(self, request: dict) -> dict:
        try:
            vm_id = normalize_vm_id(request.get("vm_id"))
        except BackendError:
            raise
        tenant_id = self._tenant(request.get("tenant_id"))
        resource_values = (request.get("vcpus"), request.get("memory_mib"), request.get("disk_gib"))
        if any(not isinstance(value, int) or isinstance(value, bool) for value in resource_values):
            raise BackendError("vcpus, memory_mib, and disk_gib must be JSON integers", 400)
        vcpus, memory_mib, disk_gib = resource_values
        if not (1 <= vcpus <= self.config.max_vcpus and 256 <= memory_mib <= self.config.max_memory_mib and 1 <= disk_gib <= self.config.max_disk_gib):
            raise BackendError("requested VM resources exceed configured per-VM limits", 422)
        hostname = request.get("hostname", "vps-" + vm_id[:8])
        username = request.get("username", "ubuntu")
        if not isinstance(hostname, str) or not _HOST.fullmatch(hostname) or not isinstance(username, str) or not _USER.fullmatch(username):
            raise BackendError("invalid hostname or cloud-init username", 400)
        ssh_key = validate_ssh_key(request.get("ssh_public_key", ""))
        image = self._image(request.get("image"))
        self.storage.verify_pool()
        self.network.ensure()
        total_cpu, total_memory = self._capacity()
        external_cpu, external_memory = self._external_reservations()
        usable_cpu = total_cpu - external_cpu
        usable_memory = total_memory - external_memory
        vm_id = str(uuid.UUID(vm_id))
        domain = "vps-" + vm_id
        mac = self._mac(vm_id)
        root_volume = domain + "-root.qcow2"
        seed_volume = domain + "-seed.iso"
        if self.state.vm_id_seen(vm_id):
            raise BackendError("vm_id already exists or was previously used; use a new UUID", 409)
        if usable_cpu - self.config.reserve_cpu < vcpus or usable_memory - self.config.reserve_memory_mib < memory_mib:
            raise BackendError("host capacity is below the request after operator reserves", 503)
        if domain in self._virsh("list", "--all", "--name").splitlines():
            raise BackendError("libvirt domain name already exists outside this agent", 409)
        try:
            ip = self.network.allocate(vm_id=vm_id, tenant_id=tenant_id, mac=mac)
            self.state.reserve_vm({"vm_id": vm_id, "tenant_id": tenant_id, "domain": domain, "vcpus": vcpus, "memory_mib": memory_mib, "disk_gib": disk_gib, "mac": mac, "ip": ip}, usable_cpu, usable_memory, self.config.reserve_cpu, self.config.reserve_memory_mib)
        except StateConflict as exc:
            self.network.release(vm_id, mac)
            raise BackendError(str(exc), 409) from exc
        defined = False
        created_volumes: list[str] = []
        try:
            size_bytes = disk_gib * 1024 * 1024 * 1024
            self.storage.create(root_volume, size_bytes, "qcow2")
            created_volumes.append(root_volume)
            with tempfile.TemporaryDirectory(prefix="vps-cloud-init-") as tmp:
                tmp_path = Path(tmp)
                user_data = tmp_path / "user-data"
                meta_data = tmp_path / "meta-data"
                network_data = tmp_path / "network-config"
                seed_iso = tmp_path / "seed.iso"
                root_overlay = tmp_path / "root.qcow2"
                user_data.write_text(self._user_data(hostname, username, ssh_key), encoding="utf-8")
                meta_data.write_text("instance-id: " + vm_id + "\nlocal-hostname: " + hostname + "\n", encoding="utf-8")
                network_data.write_text("version: 2\nethernets:\n  id0:\n    match:\n      macaddress: '" + mac + "'\n    dhcp4: true\n", encoding="utf-8")
                self.runner.run("qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(image), str(root_overlay), str(size_bytes))
                if not root_overlay.is_file() or root_overlay.stat().st_size <= 0:
                    raise BackendError("qemu-img did not produce a root overlay", 503)
                self.storage.upload(root_volume, root_overlay)
                self.runner.run("cloud-localds", "--network-config", str(network_data), str(seed_iso), str(user_data), str(meta_data))
                if not seed_iso.is_file() or seed_iso.stat().st_size <= 0:
                    raise BackendError("cloud-localds did not produce a seed image", 503)
                seed_size = ((seed_iso.stat().st_size + 1024 * 1024 - 1) // (1024 * 1024)) * (1024 * 1024)
                self.storage.create(seed_volume, seed_size, "raw")
                created_volumes.append(seed_volume)
                self.storage.upload(seed_volume, seed_iso)
            xml = self._domain_xml(vm_id, memory_mib, vcpus, mac, root_volume, seed_volume)
            ET.fromstring(xml)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", prefix="vps-domain-", suffix=".xml", delete=False) as f:
                f.write(xml)
                xml_path = f.name
            try:
                self._virsh("define", xml_path)
                defined = True
            finally:
                Path(xml_path).unlink(missing_ok=True)
            self._virsh("start", domain)
            state = self._domain_state(domain)
            if state != "running":
                raise BackendError("libvirt did not report the newly created VM as running", 502)
            self.state.set_vm_status(vm_id, "running", ip)
            return {"vm_id": vm_id, "tenant_id": tenant_id, "status": "running", "vcpus": vcpus, "memory_mib": memory_mib, "disk_gib": disk_gib, "private_ipv4": ip, "public_ipv4": None, "public_network": "NOT CONNECTED"}
        except Exception as exc:
            cleanup_ok = True
            domain_safe = not defined
            if defined:
                try:
                    current = self._domain_state(domain)
                    if current in {"shut off", "shutoff", "crashed"}:
                        self._virsh("undefine", domain)
                        domain_safe = True
                    else:
                        domain_safe = False
                        cleanup_ok = False
                except Exception:
                    domain_safe = False
                    cleanup_ok = False
            if domain_safe:
                for volume in reversed(created_volumes):
                    try:
                        self.storage.delete(volume)
                    except Exception:
                        cleanup_ok = False
                if cleanup_ok:
                    try:
                        self.network.release(vm_id, mac)
                    except Exception:
                        cleanup_ok = False
            else:
                cleanup_ok = False
            self.state.set_vm_status(vm_id, "deleted" if cleanup_ok else "failed", ip)
            if isinstance(exc, (BackendError, StorageError, NetworkError, CommandError)):
                raise BackendError("provisioning failed; host command did not confirm success: " + str(exc), 502) from exc
            raise BackendError("provisioning failed; resources were not reported as ready", 502) from exc

    def _domain_state(self, domain: str) -> str:
        try:
            value = self._virsh("domstate", domain).strip().lower()
        except CommandError as exc:
            raise BackendError("libvirt could not read VM state", 502) from exc
        allowed = {"running", "blocked", "paused", "shutdown", "shut off", "shutoff", "crashed", "pmsuspended"}
        if value not in allowed:
            raise BackendError("libvirt returned an unknown VM state", 502)
        return value

    def get_vm(self, vm_id: str, tenant_id: str) -> dict:
        vm = self._owned(vm_id, tenant_id)
        try:
            actual = self._domain_state(vm["domain"])
        except BackendError:
            if vm["status"] not in {"failed", "deleting"}:
                raise
            actual = vm["status"] + " (libvirt state unavailable; operator inspection required)"
        return {"vm_id": vm["vm_id"], "tenant_id": vm["tenant_id"], "status": actual, "vcpus": vm["vcpus"], "memory_mib": vm["memory_mib"], "disk_gib": vm["disk_gib"], "private_ipv4": vm["ip"], "public_ipv4": None, "public_network": "NOT CONNECTED"}

    def lifecycle(self, vm_id: str, tenant_id: str, action: str) -> dict:
        vm = self._owned(vm_id, tenant_id)
        domain = vm["domain"]
        state = self._domain_state(domain)
        if action == "start":
            if state == "running":
                return {"vm_id": vm_id, "status": "running"}
            if state not in {"shut off", "shutoff", "crashed"}:
                raise BackendError("VM cannot be started from its current state")
            self._virsh("start", domain)
            actual = self._domain_state(domain)
            if actual != "running":
                raise BackendError("libvirt did not confirm the VM is running", 502)
        elif action == "shutdown":
            if state in {"shut off", "shutoff"}:
                return {"vm_id": vm_id, "status": "shut off"}
            if state != "running":
                raise BackendError("graceful shutdown requires a running VM")
            self._virsh("shutdown", domain)
            deadline = time.monotonic() + min(30, self.config.command_timeout)
            actual = self._domain_state(domain)
            while actual not in {"shut off", "shutoff"} and time.monotonic() < deadline:
                time.sleep(0.2)
                actual = self._domain_state(domain)
            if actual not in {"shut off", "shutoff"}:
                raise BackendError("graceful shutdown is still pending; VM is not reported stopped", 504)
        elif action == "reboot":
            if state != "running":
                raise BackendError("reboot requires a running VM")
            self._virsh("reboot", domain)
            actual = self._domain_state(domain)
            if actual != "running":
                raise BackendError("libvirt did not confirm VM returned to running state", 502)
        else:
            raise BackendError("unsupported lifecycle action", 400)
        self.state.set_vm_status(vm_id, actual)
        return {"vm_id": vm_id, "status": actual}

    def delete_vm(self, vm_id: str, tenant_id: str) -> dict:
        vm = self._owned(vm_id, tenant_id)
        domain = vm["domain"]
        names = self._virsh("list", "--all", "--name").splitlines()
        if domain in names:
            state = self._domain_state(domain)
            if state not in {"shut off", "shutoff"}:
                raise BackendError("VM must be gracefully shut down before deletion; force-stop is disabled", 409)
        self.state.set_vm_status(vm_id, "deleting")
        if domain in names:
            self._virsh("undefine", domain)
        self.storage.delete(domain + "-root.qcow2")
        self.storage.delete(domain + "-seed.iso")
        self.network.release(vm_id, vm["mac"])
        self.state.set_vm_status(vm_id, "deleted")
        return {"vm_id": vm_id, "status": "deleted"}

    def resize_disk(self, vm_id: str, tenant_id: str, disk_gib: int) -> dict:
        vm = self._owned(vm_id, tenant_id)
        if not isinstance(disk_gib, int) or disk_gib <= vm["disk_gib"] or disk_gib > self.config.max_disk_gib:
            raise BackendError("disk resize must be a larger integer size within the configured limit", 422)
        current = self._domain_state(vm["domain"])
        if current not in {"shut off", "shutoff"}:
            raise BackendError("disk resize requires a shut off VM", 409)
        name = vm["domain"] + "-root.qcow2"
        self.storage.resize_grow_only(name, disk_gib * 1024 * 1024 * 1024)
        self.state.set_vm_disk_size(vm_id, disk_gib)
        return {"vm_id": vm_id, "disk_gib": disk_gib, "status": "resized", "vm_state": current}

    def host_inventory(self) -> dict:
        cpu_total, memory_mib = self._capacity()
        external_cpu, external_memory = self._external_reservations()
        managed = self.state.vms()
        managed_cpu = sum(vm["vcpus"] for vm in managed)
        managed_memory = sum(vm["memory_mib"] for vm in managed)
        try:
            storage = {"status": "CONNECTED", **self.storage.pool_capacity()}
        except (StorageError, CommandError) as exc:
            storage = {"status": "BLOCKED", "reason": str(exc)}
        private_network = self.network.inspect()
        return {
            "host_id": self.config.host_id,
            "status": "CONNECTED",
            "libvirt_uri": self.uri,
            "cpu_threads": cpu_total,
            "memory_mib": memory_mib,
            "allocated_vcpus": managed_cpu + external_cpu,
            "available_vcpus": max(0, cpu_total - managed_cpu - external_cpu - self.config.reserve_cpu),
            "allocated_memory_mib": managed_memory + external_memory,
            "available_memory_mib": max(0, memory_mib - managed_memory - external_memory - self.config.reserve_memory_mib),
            "storage": storage,
            "private_network": private_network,
            "public_network": self.public_network_status(),
        }

    def public_network_status(self) -> dict:
        return {"status": "NOT CONNECTED", "reason": self.config.public_network_status, "public_ipv4_assignment": False}
