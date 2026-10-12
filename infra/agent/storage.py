from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from .runner import CommandError, CommandRunner

_VOLUME = re.compile(r"^vps-[0-9a-f-]{36}-(?:root\.qcow2|seed\.iso|data-[a-z0-9-]+\.qcow2)$")


class StorageError(RuntimeError):
    pass


class SafeStorage:
    """Use only a pre-existing libvirt directory pool at the exact configured path."""

    def __init__(self, runner: CommandRunner, pool: str, storage_path: Path, uri: str = "qemu:///system"):
        self.runner = runner
        self.pool = pool
        self.storage_path = storage_path.resolve(strict=True)
        self.uri = uri
        if self.storage_path == Path("/") or not self.storage_path.is_dir():
            raise StorageError("configured storage path must be a dedicated existing directory")

    def _virsh(self, *args: str) -> str:
        return self.runner.run("virsh", "-c", self.uri, *args)

    def verify_pool(self) -> dict:
        try:
            info = self._virsh("pool-info", self.pool)
            xml = self._virsh("pool-dumpxml", self.pool)
        except CommandError as exc:
            raise StorageError("configured libvirt storage pool is unavailable") from exc
        root = ET.fromstring(xml)
        pool_type = root.attrib.get("type")
        target = root.findtext("./target/path")
        if pool_type != "dir" or not target:
            raise StorageError("only an operator-created directory pool is supported; block devices are never initialized")
        actual = Path(target).resolve(strict=True)
        if actual != self.storage_path or actual == Path("/"):
            raise StorageError("libvirt pool path does not exactly match the configured dedicated storage directory")
        if "State: running" not in info:
            raise StorageError("libvirt storage pool is not running")
        return {"name": self.pool, "type": pool_type, "path": str(actual), "state": "running"}

    def _check_name(self, name: str) -> None:
        if not _VOLUME.fullmatch(name):
            raise StorageError("volume name is not a managed VPS volume")

    def volume_path(self, name: str) -> Path:
        self._check_name(name)
        self.verify_pool()
        path = Path(self._virsh("vol-path", name, "--pool", self.pool)).resolve(strict=False)
        if path.parent != self.storage_path or path.name != name:
            raise StorageError("libvirt returned a volume path outside the managed storage pool")
        return path

    def create(self, name: str, capacity_bytes: int, fmt: str = "qcow2") -> Path:
        self._check_name(name)
        if not (1024 * 1024 <= capacity_bytes <= 1024 * 1024 * 1024 * 1024):
            raise StorageError("volume capacity must be between 1 MiB and 1 TiB")
        if fmt not in {"qcow2", "raw"}:
            raise StorageError("only qcow2 and raw volumes are supported")
        self.verify_pool()
        info = self._virsh("pool-info", self.pool, "--bytes")
        available = None
        for line in info.splitlines():
            if line.strip().startswith("Available:"):
                try:
                    available = int(line.split(":", 1)[1].strip().split()[0])
                except (ValueError, IndexError):
                    available = None
        if available is None:
            raise StorageError("libvirt did not report verifiable free bytes for the storage pool")
        if capacity_bytes > available:
            raise StorageError("storage pool has insufficient reported free capacity")
        try:
            self._virsh("vol-create-as", self.pool, name, str(capacity_bytes), "--format", fmt)
            path = self.volume_path(name)
        except CommandError as exc:
            raise StorageError("libvirt volume creation failed") from exc
        if not path.exists():
            raise StorageError("libvirt reported volume creation but the volume path is absent")
        return path

    def upload(self, name: str, source: Path) -> None:
        self._check_name(name)
        target = self.volume_path(name)
        src = source.resolve(strict=True)
        if not src.is_file() or src.stat().st_size <= 0:
            raise StorageError("upload source must be a non-empty regular file")
        try:
            self._virsh("vol-upload", name, str(src), "--pool", self.pool, "--sparse")
        except CommandError as exc:
            raise StorageError("libvirt volume upload failed; volume retained for operator inspection") from exc
        if not target.exists():
            raise StorageError("volume disappeared after upload")

    def capacity_bytes(self, name: str) -> int:
        self._check_name(name)
        xml = self._virsh("vol-dumpxml", name, "--pool", self.pool)
        root = ET.fromstring(xml)
        capacity = root.findtext("./capacity")
        if not capacity or not capacity.isdigit():
            raise StorageError("libvirt returned an invalid volume capacity")
        return int(capacity)

    def _references(self, name: str) -> list[str]:
        domains = self._virsh("list", "--all", "--name").splitlines()
        references = []
        for domain in filter(None, domains):
            try:
                snapshots = self._virsh("snapshot-list", domain, "--name").splitlines()
            except CommandError as exc:
                raise StorageError("cannot inspect domain snapshots; refusing volume deletion") from exc
            snapshots = [name.strip() for name in snapshots if name.strip() and set(name.strip()) != {"-"} and name.strip().lower() != "name"]
            if snapshots:
                raise StorageError("refusing volume deletion while libvirt snapshots exist; inspect or remove them separately")
            try:
                xml = ET.fromstring(self._virsh("dumpxml", domain))
            except CommandError as exc:
                raise StorageError("cannot inspect every libvirt domain; refusing volume deletion") from exc
            for source in xml.findall(".//disk/source"):
                if source.attrib.get("pool") == self.pool and source.attrib.get("volume") == name:
                    references.append(domain)
                elif source.attrib.get("file"):
                    try:
                        if Path(source.attrib["file"]).resolve(strict=False) == self.volume_path(name):
                            references.append(domain)
                    except StorageError:
                        pass
        return references

    def delete(self, name: str) -> None:
        self._check_name(name)
        self.verify_pool()
        listed = {entry["name"] for entry in self.inventory()}
        if name not in listed:
            return
        refs = self._references(name)
        if refs:
            raise StorageError("refusing to delete a volume referenced by a VM: " + ", ".join(refs[:10]))
        try:
            self._virsh("vol-delete", name, "--pool", self.pool)
        except CommandError as exc:
            raise StorageError("libvirt volume deletion failed") from exc

    def resize_grow_only(self, name: str, new_capacity_bytes: int) -> None:
        self._check_name(name)
        current = self.capacity_bytes(name)
        if new_capacity_bytes <= current:
            raise StorageError("volume shrinking is disabled; requested size must be larger")
        if new_capacity_bytes > 1024 * 1024 * 1024 * 1024:
            raise StorageError("volume capacity cannot exceed 1 TiB")
        capacity = self.pool_capacity()
        if new_capacity_bytes - current > capacity["available"]:
            raise StorageError("storage pool has insufficient reported free capacity for the requested growth")
        refs = self._references(name)
        for domain in refs:
            state = self._virsh("domstate", domain).lower()
            if "shut off" not in state and "shutoff" not in state:
                raise StorageError("online volume resize is not enabled; VM must be shut off")
        try:
            self._virsh("vol-resize", name, str(new_capacity_bytes), "--pool", self.pool)
            if self.capacity_bytes(name) < new_capacity_bytes:
                raise StorageError("libvirt did not confirm the requested volume capacity")
        except CommandError as exc:
            raise StorageError("libvirt volume resize failed") from exc

    def pool_capacity(self) -> dict:
        self.verify_pool()
        info = self._virsh("pool-info", self.pool, "--bytes")
        values = {}
        for line in info.splitlines():
            key, sep, value = line.partition(":")
            if sep and key.strip() in {"Capacity", "Allocation", "Available"}:
                token = value.strip().split()[0] if value.strip() else ""
                if token.isdigit():
                    values[key.strip().lower()] = int(token)
        if set(values) != {"capacity", "allocation", "available"}:
            raise StorageError("libvirt storage capacity could not be verified")
        return values

    def inventory(self) -> list[dict]:
        self.verify_pool()
        xml = self._virsh("pool-dumpxml", self.pool)
        volumes = []
        listing = self._virsh("vol-list", self.pool, "--details")
        for line in listing.splitlines()[2:]:
            fields = line.split()
            if fields and _VOLUME.fullmatch(fields[0]):
                volumes.append({"name": fields[0], "managed": True})
        return volumes
