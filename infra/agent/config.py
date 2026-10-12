from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass
from pathlib import Path


_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def _bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    host_id: str
    bind_host: str
    port: int
    server_cert: Path
    server_key: Path
    client_ca: Path
    controller_cn: str
    state_path: Path
    libvirt_uri: str
    storage_pool: str
    storage_path: Path
    image_path: Path
    private_network: str
    private_cidr: ipaddress.IPv4Network
    private_gateway: ipaddress.IPv4Address
    dhcp_start: ipaddress.IPv4Address
    dhcp_end: ipaddress.IPv4Address
    bridge: str
    allow_network_create: bool
    reserve_cpu: int
    reserve_memory_mib: int
    max_vcpus: int
    max_memory_mib: int
    max_disk_gib: int
    command_timeout: int

    @classmethod
    def from_env(cls) -> "Config":
        cidr = ipaddress.ip_network(_required("VPS_AGENT_PRIVATE_CIDR"), strict=True)
        if not isinstance(cidr, ipaddress.IPv4Network) or not cidr.is_private:
            raise ValueError("VPS_AGENT_PRIVATE_CIDR must be a private IPv4 network")
        gateway = ipaddress.ip_address(_required("VPS_AGENT_PRIVATE_GATEWAY"))
        start = ipaddress.ip_address(_required("VPS_AGENT_DHCP_START"))
        end = ipaddress.ip_address(_required("VPS_AGENT_DHCP_END"))
        if any(not isinstance(x, ipaddress.IPv4Address) or x not in cidr for x in (gateway, start, end)):
            raise ValueError("gateway and DHCP range must be IPv4 addresses inside the private CIDR")
        if int(start) > int(end) or int(start) <= int(gateway) <= int(end):
            raise ValueError("invalid DHCP range or gateway overlap")
        if any(x in (cidr.network_address, cidr.broadcast_address) for x in (gateway, start, end)):
            raise ValueError("network and broadcast addresses cannot be assigned")
        pool = _required("VPS_AGENT_STORAGE_POOL")
        network = os.environ.get("VPS_AGENT_PRIVATE_NETWORK", "vps-private")
        bridge = os.environ.get("VPS_AGENT_PRIVATE_BRIDGE", "virbr-vps")
        for label, value in (("pool", pool), ("network", network)):
            if not _NAME.fullmatch(value):
                raise ValueError(f"invalid {label} name")
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", bridge):
            raise ValueError("invalid Linux bridge name")
        uri = os.environ.get("VPS_AGENT_LIBVIRT_URI", "qemu:///system")
        if uri != "qemu:///system":
            raise ValueError("only the local system libvirt URI is supported")
        port = int(os.environ.get("VPS_AGENT_PORT", "9443"))
        if not 1 <= port <= 65535:
            raise ValueError("VPS_AGENT_PORT is out of range")
        return cls(
            host_id=_required("VPS_AGENT_HOST_ID"),
            bind_host=os.environ.get("VPS_AGENT_BIND", "127.0.0.1"),
            port=port,
            server_cert=Path(_required("VPS_AGENT_TLS_CERT")),
            server_key=Path(_required("VPS_AGENT_TLS_KEY")),
            client_ca=Path(_required("VPS_AGENT_CLIENT_CA")),
            controller_cn=_required("VPS_AGENT_CONTROLLER_CN"),
            state_path=Path(_required("VPS_AGENT_STATE_PATH")),
            libvirt_uri=uri,
            storage_pool=pool,
            storage_path=Path(_required("VPS_AGENT_STORAGE_PATH")),
            image_path=Path(_required("VPS_AGENT_IMAGE_PATH")),
            private_network=network,
            private_cidr=cidr,
            private_gateway=gateway,
            dhcp_start=start,
            dhcp_end=end,
            bridge=bridge,
            allow_network_create=_bool("VPS_AGENT_ALLOW_NETWORK_CREATE", False),
            reserve_cpu=int(os.environ.get("VPS_AGENT_RESERVE_CPU", "1")),
            reserve_memory_mib=int(os.environ.get("VPS_AGENT_RESERVE_MEMORY_MIB", "2048")),
            max_vcpus=int(os.environ.get("VPS_AGENT_MAX_VCPUS", "16")),
            max_memory_mib=int(os.environ.get("VPS_AGENT_MAX_MEMORY_MIB", "65536")),
            max_disk_gib=int(os.environ.get("VPS_AGENT_MAX_DISK_GIB", "1024")),
            command_timeout=int(os.environ.get("VPS_AGENT_COMMAND_TIMEOUT", "30")),
        )

    def validate_paths(self) -> None:
        for path in (self.server_cert, self.server_key, self.client_ca):
            if not path.is_file():
                raise ValueError(f"TLS file does not exist: {path}")
        mode = self.server_key.stat().st_mode & 0o777
        if mode & 0o077:
            raise ValueError("TLS private key must not be accessible by group or other users (chmod 600)")
        if not self.storage_path.is_dir() or self.storage_path.is_symlink():
            raise ValueError("storage path must be an existing, non-symlink directory; agent never creates or formats pools")
        if not self.image_path.is_dir() or self.image_path.is_symlink():
            raise ValueError("image path must be an existing non-symlink directory")
        if self.state_path.parent.resolve() == Path("/"):
            raise ValueError("state path must not be located directly under /")
        if min(self.reserve_cpu, self.reserve_memory_mib, self.max_vcpus, self.max_memory_mib, self.max_disk_gib) < 0:
            raise ValueError("resource limits must be non-negative")
        if self.max_vcpus < 1 or self.max_memory_mib < 256 or self.max_disk_gib < 1:
            raise ValueError("maximum VM resources are too small")

    @property
    def public_network_status(self) -> str:
        return "NOT CONNECTED: no public routing driver is configured"
