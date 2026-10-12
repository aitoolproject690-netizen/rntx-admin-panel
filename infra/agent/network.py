from __future__ import annotations

import ipaddress
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from tempfile import NamedTemporaryFile

from .runner import CommandError, CommandRunner
from .state import AgentState, StateConflict


class NetworkError(RuntimeError):
    pass


class PrivateNetwork:
    def __init__(self, runner: CommandRunner, state: AgentState, *, name: str, cidr: ipaddress.IPv4Network, gateway: ipaddress.IPv4Address, dhcp_start: ipaddress.IPv4Address, dhcp_end: ipaddress.IPv4Address, bridge: str, allow_create: bool, uri: str = "qemu:///system"):
        self.runner, self.state, self.name, self.cidr = runner, state, name, cidr
        self.gateway, self.start, self.end, self.bridge = gateway, dhcp_start, dhcp_end, bridge
        self.allow_create, self.uri = allow_create, uri
        if not isinstance(cidr, ipaddress.IPv4Network) or not cidr.is_private or any(not isinstance(x, ipaddress.IPv4Address) or x not in cidr for x in (gateway, dhcp_start, dhcp_end)) or any(x in (cidr.network_address, cidr.broadcast_address) for x in (gateway, dhcp_start, dhcp_end)) or int(dhcp_start) > int(dhcp_end) or int(dhcp_start) <= int(gateway) <= int(dhcp_end):
            raise NetworkError("invalid private IPv4/DHCP configuration")

    def _virsh(self, *args: str) -> str:
        return self.runner.run("virsh", "-c", self.uri, *args)

    def _check_route_overlap(self) -> None:
        try:
            routes = json.loads(self.runner.run("ip", "-j", "route", "show", "table", "all"))
        except (CommandError, json.JSONDecodeError) as exc:
            raise NetworkError("cannot verify host routes; refusing to create a private network") from exc
        if not isinstance(routes, list):
            raise NetworkError("host route inventory is invalid; refusing to create a private network")
        for route in routes:
            destination = route.get("dst", "default") if isinstance(route, dict) else None
            if destination in (None, "default"):
                continue
            try:
                prefix = ipaddress.ip_network(destination, strict=False)
            except ValueError as exc:
                raise NetworkError("host route inventory contains an unknown route; refusing network creation") from exc
            if isinstance(prefix, ipaddress.IPv4Network) and prefix.overlaps(self.cidr):
                raise NetworkError("configured private CIDR overlaps an existing host route")

    def _matches_config(self, xml: str) -> bool:
        root = ET.fromstring(xml)
        if root.findtext("name") != self.name:
            return False
        forward = root.find("forward")
        bridge = root.find("bridge")
        ip = root.find("ip")
        dhcp = ip.find("dhcp") if ip is not None else None
        dhcp_range = dhcp.find("range") if dhcp is not None else None
        if not (forward is not None and forward.attrib.get("mode") == "nat" and bridge is not None and bridge.attrib.get("name") == self.bridge and ip is not None and dhcp_range is not None):
            return False
        return (ip.attrib.get("address") == str(self.gateway) and ip.attrib.get("netmask") == str(self.cidr.netmask) and dhcp_range.attrib.get("start") == str(self.start) and dhcp_range.attrib.get("end") == str(self.end))

    def _definition(self) -> str:
        root = ET.Element("network")
        ET.SubElement(root, "name").text = self.name
        ET.SubElement(root, "forward", {"mode": "nat"})
        ET.SubElement(root, "bridge", {"name": self.bridge, "stp": "on", "delay": "0"})
        ip = ET.SubElement(root, "ip", {"address": str(self.gateway), "netmask": str(self.cidr.netmask)})
        dhcp = ET.SubElement(ip, "dhcp")
        ET.SubElement(dhcp, "range", {"start": str(self.start), "end": str(self.end)})
        return ET.tostring(root, encoding="unicode")

    def ensure(self) -> dict:
        try:
            xml = self._virsh("net-dumpxml", self.name)
        except CommandError:
            if not self.allow_create:
                raise NetworkError("private libvirt network is absent; explicit VPS_AGENT_ALLOW_NETWORK_CREATE=true is required to create it")
            self._check_route_overlap()
            with NamedTemporaryFile("w", encoding="utf-8", prefix="vps-net-", suffix=".xml", delete=False) as f:
                f.write(self._definition())
                filename = f.name
            try:
                self._virsh("net-define", filename)
                self._virsh("net-autostart", self.name)
                self._virsh("net-start", self.name)
            except CommandError as exc:
                raise NetworkError("libvirt private network creation failed") from exc
            finally:
                Path(filename).unlink(missing_ok=True)
            xml = self._virsh("net-dumpxml", self.name)
        if not self._matches_config(xml):
            raise NetworkError("existing libvirt network does not match configured private NAT network; refusing to modify it")
        try:
            info = self._virsh("net-info", self.name)
        except CommandError as exc:
            raise NetworkError("libvirt network status is unavailable") from exc
        if "Active: yes" not in info:
            if not self.allow_create:
                raise NetworkError("private network is inactive; operator must start it or explicitly enable network creation")
            self._virsh("net-start", self.name)
        return {"name": self.name, "mode": "private NAT", "cidr": str(self.cidr), "state": "active"}

    def inspect(self) -> dict:
        try:
            xml = self._virsh("net-dumpxml", self.name)
            info = self._virsh("net-info", self.name)
        except CommandError:
            return {"status": "NOT CONNECTED", "reason": "configured private libvirt network is unavailable", "cidr": str(self.cidr)}
        if not self._matches_config(xml):
            return {"status": "BLOCKED", "reason": "existing network configuration does not match operator configuration", "cidr": str(self.cidr)}
        active = "Active: yes" in info
        return {"status": "CONNECTED" if active else "BLOCKED", "name": self.name, "mode": "private NAT", "cidr": str(self.cidr), "reason": None if active else "network is inactive"}

    def _lease_for(self, mac: str, address: str) -> tuple[str | None, str | None]:
        xml = self._virsh("net-dumpxml", self.name)
        root = ET.fromstring(xml)
        for host in root.findall(".//dhcp/host"):
            if host.attrib.get("mac", "").lower() == mac.lower():
                return host.attrib.get("ip"), host.attrib.get("name")
            if host.attrib.get("ip") == address:
                return host.attrib.get("ip"), host.attrib.get("name")
        return None, None

    def _ensure_dhcp_host(self, mac: str, address: str, vm_name: str) -> None:
        existing, existing_name = self._lease_for(mac, address)
        if existing == address and existing_name == vm_name:
            return
        if existing is not None:
            raise NetworkError("MAC or address conflicts with an existing libvirt DHCP reservation")
        host = ET.Element("host", {"mac": mac, "name": vm_name, "ip": address})
        fragment = ET.tostring(host, encoding="unicode")
        try:
            self._virsh("net-update", self.name, "add", "ip-dhcp-host", "--xml", fragment, "--live", "--config")
        except CommandError as exc:
            raise NetworkError("libvirt DHCP reservation update failed; lease remains pending for safe retry") from exc

    def allocate(self, *, vm_id: str, tenant_id: str, mac: str) -> str:
        self.ensure()
        try:
            address = self.state.allocate_ip(self.name, self.cidr, self.gateway, self.start, self.end, vm_id, tenant_id, mac)
            self._ensure_dhcp_host(mac, address, "vps-" + vm_id)
            self.state.set_lease_status(vm_id, "active")
            return address
        except StateConflict as exc:
            raise NetworkError(str(exc)) from exc

    def release(self, vm_id: str, mac: str) -> None:
        lease = next((row for row in self.state.leases() if row["vm_id"] == vm_id), None)
        if not lease:
            return
        address = lease["ip"]
        existing, _ = self._lease_for(mac, address)
        if existing:
            host = ET.Element("host", {"mac": mac, "ip": address})
            try:
                info = self._virsh("net-info", self.name)
                mode = ["--config"] + (["--live"] if "Active: yes" in info else [])
                self._virsh("net-update", self.name, "delete", "ip-dhcp-host", "--xml", ET.tostring(host, encoding="unicode"), *mode)
            except CommandError as exc:
                raise NetworkError("libvirt DHCP reservation removal failed; IP remains reserved") from exc
        self.state.release_lease(vm_id)


class PublicNetworkNotConnected(NetworkError):
    pass


def allocate_public_ip(*_args, **_kwargs):
    raise PublicNetworkNotConnected("public IP allocation is NOT CONNECTED: configure and verify an upstream routed address pool before enabling it")
