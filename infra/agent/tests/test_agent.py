from __future__ import annotations

import base64
import ipaddress
import struct
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from infra.agent.config import Config
from infra.agent.libvirt_backend import BackendError, LibvirtBackend, validate_ssh_key
from infra.agent.network import NetworkError, PrivateNetwork, PublicNetworkNotConnected
from infra.agent.runner import CommandError, CommandRunner
from infra.agent.server import Handler
from infra.agent.state import AgentState, StateConflict
from infra.agent.storage import SafeStorage, StorageError


class FakeRunner:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    def run(self, *argv, **kwargs):
        self.calls.append(tuple(argv))
        key = argv[3:] if argv[:2] == ("virsh", "-c") else argv
        value = self.responses.get(tuple(key), self.responses.get(key[0] if key else "", self.responses.get(key[-1] if key else "", "")))
        if isinstance(value, list):
            value = value.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


def valid_ssh_key() -> str:
    blob = struct.pack(">I", len(b"ssh-ed25519")) + b"ssh-ed25519" + (b"x" * 32)
    return "ssh-ed25519 " + base64.b64encode(blob).decode() + " test-key"


def make_config(root: Path) -> Config:
    return Config(
        host_id="test-node", bind_host="127.0.0.1", port=9443,
        server_cert=root / "cert.pem", server_key=root / "key.pem", client_ca=root / "ca.pem",
        controller_cn="control-plane", state_path=root / "state" / "agent.sqlite3",
        libvirt_uri="qemu:///system", storage_pool="vps-pool", storage_path=root / "pool",
        image_path=root / "images", private_network="vps-private",
        private_cidr=ipaddress.ip_network("10.20.0.0/29"),
        private_gateway=ipaddress.ip_address("10.20.0.1"),
        dhcp_start=ipaddress.ip_address("10.20.0.2"), dhcp_end=ipaddress.ip_address("10.20.0.3"),
        bridge="virbr-vps", allow_network_create=False, reserve_cpu=1, reserve_memory_mib=512,
        max_vcpus=16, max_memory_mib=65536, max_disk_gib=1024, command_timeout=2,
    )


def add_vm(state: AgentState, vm_id: str, tenant: str = "tenant-a", status: str = "stopped"):
    state.reserve_vm({"vm_id": vm_id, "tenant_id": tenant, "domain": "vps-" + vm_id,
                      "vcpus": 1, "memory_mib": 512, "disk_gib": 8,
                      "mac": "52:54:00:00:00:01", "ip": "10.20.0.2"}, 8, 8192, 1, 512)
    state.set_vm_status(vm_id, status)


class RunnerTests(unittest.TestCase):
    def test_runner_uses_argument_vector_not_shell(self):
        with patch("infra.agent.runner.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="ok\n", stderr="")) as run:
            self.assertEqual(CommandRunner().run("virsh", "domstate", "safe-name"), "ok")
            self.assertEqual(run.call_args.args[0], ["virsh", "domstate", "safe-name"])
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_command_failure_is_not_a_success(self):
        with patch("infra.agent.runner.subprocess.run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="denied")):
            with self.assertRaises(CommandError):
                CommandRunner().run("virsh", "start", "vps-test")


class StateTests(unittest.TestCase):
    def test_idempotency_replays_same_payload_and_rejects_key_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            key = str(uuid.uuid4())
            digest, cached = state.idempotency_begin(key, "POST", "/v1/vms", b'{"a":1}')
            self.assertIsNone(cached)
            state.idempotency_finish(key, digest, {"status": 201, "body": {"ok": True}})
            _, replay = state.idempotency_begin(key, "POST", "/v1/vms", b'{"a":1}')
            self.assertEqual(replay, {"status": 201, "body": {"ok": True}})
            with self.assertRaises(StateConflict):
                state.idempotency_begin(key, "POST", "/v1/vms", b'{"a":2}')

    def test_state_refuses_symlink_database_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "outside.db"
            target.write_text("not a database")
            link = root / "agent.db"
            link.symlink_to(target)
            with self.assertRaises(PermissionError):
                AgentState(link)

    def test_capacity_reservations_enforce_cpu_and_ram(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            vm = {"vm_id": str(uuid.uuid4()), "tenant_id": "t", "domain": "vps-a", "vcpus": 2, "memory_mib": 2048, "disk_gib": 10, "mac": "52:54:00:00:00:01", "ip": None}
            state.reserve_vm(vm, 4, 4096, 1, 1024)
            vm2 = {**vm, "vm_id": str(uuid.uuid4()), "domain": "vps-b"}
            with self.assertRaises(StateConflict):
                state.reserve_vm(vm2, 4, 4096, 1, 1024)

    def test_private_ip_allocation_is_unique_excludes_gateway_and_exhausts_safely(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            network = ipaddress.ip_network("10.20.0.0/29")
            gateway = ipaddress.ip_address("10.20.0.1")
            start, end = ipaddress.ip_address("10.20.0.1"), ipaddress.ip_address("10.20.0.3")
            first = state.allocate_ip("private", network, gateway, start, end, str(uuid.uuid4()), "tenant-a", "52:54:00:00:00:01")
            second = state.allocate_ip("private", network, gateway, start, end, str(uuid.uuid4()), "tenant-b", "52:54:00:00:00:02")
            self.assertEqual((first, second), ("10.20.0.2", "10.20.0.3"))
            with self.assertRaises(StateConflict):
                state.allocate_ip("private", network, gateway, start, end, str(uuid.uuid4()), "tenant-c", "52:54:00:00:00:03")

    def test_released_private_ip_can_be_reused_but_identity_cannot_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            network = ipaddress.ip_network("10.20.0.0/29")
            gateway = ipaddress.ip_address("10.20.0.1")
            start = end = ipaddress.ip_address("10.20.0.2")
            first = str(uuid.uuid4())
            second = str(uuid.uuid4())
            ip = state.allocate_ip("private", network, gateway, start, end, first, "tenant-a", "52:54:00:00:00:01")
            state.release_lease(first)
            self.assertEqual(state.allocate_ip("private", network, gateway, start, end, second, "tenant-b", "52:54:00:00:00:02"), ip)
            with self.assertRaises(StateConflict):
                state.allocate_ip("private", network, gateway, start, end, second, "tenant-c", "52:54:00:00:00:02")


class NetworkTests(unittest.TestCase):
    def test_private_network_rejects_broadcast_dhcp_address(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            with self.assertRaises(NetworkError):
                PrivateNetwork(FakeRunner(), state, name="vps-private", cidr=ipaddress.ip_network("10.20.0.0/29"), gateway=ipaddress.ip_address("10.20.0.1"), dhcp_start=ipaddress.ip_address("10.20.0.2"), dhcp_end=ipaddress.ip_address("10.20.0.7"), bridge="virbr-vps", allow_create=False)

    def test_private_network_config_matches_operator_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            network = PrivateNetwork(FakeRunner(), state, name="vps-private", cidr=ipaddress.ip_network("10.20.0.0/29"), gateway=ipaddress.ip_address("10.20.0.1"), dhcp_start=ipaddress.ip_address("10.20.0.2"), dhcp_end=ipaddress.ip_address("10.20.0.6"), bridge="virbr-vps", allow_create=False)
            xml = network._definition()
            self.assertTrue(network._matches_config(xml))
            self.assertFalse(network._matches_config(xml.replace("10.20.0.1", "10.99.0.1")))

    def test_private_allocation_requires_libvirt_confirmation(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            runner = FakeRunner({
                "net-dumpxml": ["<network><name>vps-private</name></network>", "<network><name>vps-private</name></network>"],
                "net-info": "Active: yes",
                "net-update": "",
            })
            network = PrivateNetwork(runner, state, name="vps-private", cidr=ipaddress.ip_network("10.20.0.0/29"), gateway=ipaddress.ip_address("10.20.0.1"), dhcp_start=ipaddress.ip_address("10.20.0.2"), dhcp_end=ipaddress.ip_address("10.20.0.3"), bridge="virbr-vps", allow_create=False)
            # Existing XML needs the complete configured shape before a real lease is allowed.
            runner.responses["net-dumpxml"] = [network._definition(), network._definition()]
            ip = network.allocate(vm_id=str(uuid.uuid4()), tenant_id="tenant-a", mac="52:54:00:00:00:01")
            self.assertEqual(ip, "10.20.0.2")
            self.assertIn("net-update", [call[3] for call in runner.calls if len(call) > 3])
            self.assertEqual(state.leases()[0]["status"], "active")

    def test_network_creation_refuses_overlap_with_host_route(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            runner = FakeRunner({"net-dumpxml": CommandError(("virsh",), 1, "network absent"), "ip": '[{"dst":"10.20.0.0/24","dev":"eth0"}]'})
            network = PrivateNetwork(runner, state, name="vps-private", cidr=ipaddress.ip_network("10.20.0.0/29"), gateway=ipaddress.ip_address("10.20.0.1"), dhcp_start=ipaddress.ip_address("10.20.0.2"), dhcp_end=ipaddress.ip_address("10.20.0.3"), bridge="virbr-vps", allow_create=True)
            with self.assertRaisesRegex(NetworkError, "overlaps"):
                network.ensure()
            self.assertFalse(any(call[0] == "net-define" for call in runner.calls))

    def test_inspect_is_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = AgentState(Path(tmp) / "agent.db")
            runner = FakeRunner({"net-dumpxml": "<network><name>vps-private</name></network>", "net-info": "Active: yes"})
            network = PrivateNetwork(runner, state, name="vps-private", cidr=ipaddress.ip_network("10.20.0.0/29"), gateway=ipaddress.ip_address("10.20.0.1"), dhcp_start=ipaddress.ip_address("10.20.0.2"), dhcp_end=ipaddress.ip_address("10.20.0.3"), bridge="virbr-vps", allow_create=True)
            self.assertEqual(network.inspect()["status"], "BLOCKED")
            self.assertFalse(any("net-start" in call or "net-define" in call for call in runner.calls))

    def test_public_ip_is_explicitly_not_connected(self):
        from infra.agent.network import allocate_public_ip
        with self.assertRaises(PublicNetworkNotConnected):
            allocate_public_ip()


class StorageTests(unittest.TestCase):
    def _storage(self, tmp: Path, referenced: bool = True, inaccessible_domain: bool = False, snapshots: bool = False):
        pool = tmp / "pool"
        pool.mkdir()
        storage = SafeStorage(FakeRunner(), "vps-pool", pool)
        volume = "vps-" + str(uuid.uuid4()) + "-root.qcow2"
        calls = []
        def command(*args):
            calls.append(args)
            if args[0] == "pool-info": return "State: running"
            if args[0] == "vol-list": return "Name Path Type Capacity Allocation\n----\n" + volume + " /pool/" + volume + " qcow2 1 1"
            if args[0] == "snapshot-list": return "customer-snapshot" if snapshots else ""
            if args[0] == "pool-dumpxml": return f"<pool type='dir'><name>vps-pool</name><target><path>{pool}</path></target></pool>"
            if args[0] == "list": return "vps-domain" if referenced or inaccessible_domain else ""
            if args[0] == "dumpxml":
                if inaccessible_domain: raise CommandError(args, 1, "denied")
                return f"<domain><devices><disk><source pool='vps-pool' volume='{volume}'/></disk></devices></domain>"
            if args[0] == "vol-delete": return ""
            if args[0] == "vol-path": return str(pool / args[1])
            return ""
        storage._virsh = command
        return storage, volume, calls

    def test_volume_delete_refuses_any_domain_reference(self):
        with tempfile.TemporaryDirectory() as d:
            storage, volume, calls = self._storage(Path(d), referenced=True)
            with self.assertRaises(StorageError):
                storage.delete(volume)
            self.assertFalse(any(args[0] == "vol-delete" for args in calls))

    def test_volume_delete_fails_closed_if_domain_xml_cannot_be_inspected(self):
        with tempfile.TemporaryDirectory() as d:
            storage, volume, calls = self._storage(Path(d), referenced=False, inaccessible_domain=True)
            with self.assertRaises(StorageError):
                storage.delete(volume)
            self.assertFalse(any(args[0] == "vol-delete" for args in calls))

    def test_volume_delete_refuses_when_any_domain_snapshot_exists(self):
        with tempfile.TemporaryDirectory() as d:
            storage, volume, calls = self._storage(Path(d), referenced=True, snapshots=True)
            with self.assertRaisesRegex(StorageError, "snapshots exist"):
                storage.delete(volume)
            self.assertFalse(any(args[0] == "vol-delete" for args in calls))

    def test_pool_path_must_exactly_match_configured_dedicated_directory(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            pool = root / "pool"
            pool.mkdir()
            storage = SafeStorage(FakeRunner(), "vps-pool", pool)
            storage._virsh = lambda *args: "State: running" if args[0] == "pool-info" else f"<pool type='dir'><target><path>{root}</path></target></pool>"
            with self.assertRaises(StorageError):
                storage.verify_pool()

    def test_resize_never_shrinks(self):
        with tempfile.TemporaryDirectory() as d:
            storage, volume, calls = self._storage(Path(d), referenced=False)
            storage.capacity_bytes = lambda name: 1024 * 1024 * 1024
            with self.assertRaises(StorageError):
                storage.resize_grow_only(volume, 512 * 1024 * 1024)
            self.assertFalse(any(args[0] == "vol-resize" for args in calls))

    def test_resize_refuses_growth_beyond_reported_free_capacity(self):
        with tempfile.TemporaryDirectory() as d:
            storage, volume, calls = self._storage(Path(d), referenced=False)
            storage.capacity_bytes = lambda name: 1024 * 1024 * 1024
            storage.pool_capacity = lambda: {"capacity": 1024 * 1024 * 1024, "allocation": 1023 * 1024 * 1024, "available": 1024 * 1024}
            storage._references = lambda name: []
            with self.assertRaisesRegex(StorageError, "insufficient reported free capacity"):
                storage.resize_grow_only(volume, 2 * 1024 * 1024 * 1024)
            self.assertFalse(any(args[0] == "vol-resize" for args in calls))


class BackendTests(unittest.TestCase):
    def test_cross_tenant_lookup_returns_not_found_without_host_command(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = AgentState(root / "state.db")
            vm_id = str(uuid.uuid4())
            add_vm(state, vm_id, "tenant-a")
            runner = FakeRunner()
            backend = LibvirtBackend(make_config(root), runner, state, object(), object())
            with self.assertRaises(BackendError) as caught:
                backend.get_vm(vm_id, "tenant-b")
            self.assertEqual(caught.exception.status, 404)
            self.assertEqual(runner.calls, [])

    def test_start_requires_libvirt_confirmation(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = AgentState(root / "state.db")
            vm_id = str(uuid.uuid4())
            add_vm(state, vm_id)
            domain = "vps-" + vm_id
            runner = FakeRunner({"domstate": ["shut off", "running"], "start": ""})
            backend = LibvirtBackend(make_config(root), runner, state, object(), object())
            result = backend.lifecycle(vm_id, "tenant-a", "start")
            self.assertEqual(result["status"], "running")
            self.assertTrue(any(call[-2:] == ("start", domain) for call in runner.calls))

    def test_failed_delete_is_left_deleting_not_reported_as_running(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = AgentState(root / "state.db")
            vm_id = str(uuid.uuid4())
            add_vm(state, vm_id, status="stopped")
            class FailedStorage:
                def delete(self, name):
                    raise StorageError("test failure")
            runner = FakeRunner({"list": ""})
            backend = LibvirtBackend(make_config(root), runner, state, FailedStorage(), object())
            with self.assertRaises(StorageError):
                backend.delete_vm(vm_id, "tenant-a")
            self.assertEqual(state.vm(vm_id)["status"], "deleting")
            runner.responses["domstate"] = CommandError(("virsh",), 1, "domain is absent")
            self.assertIn("deleting", backend.get_vm(vm_id, "tenant-a")["status"])

    def test_ssh_key_validation_rejects_multiline_input(self):
        with self.assertRaises(BackendError):
            validate_ssh_key("ssh-ed25519 YWFh\nssh-ed25519 YWFh")

    def test_host_inventory_uses_libvirt_capacity_and_reports_reserved_resources(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = AgentState(root / "state.db")
            runner = FakeRunner({"nodeinfo": "CPU(s): 8\nMemory size: 8388608 KiB"})
            storage = SimpleNamespace(pool_capacity=lambda: {"capacity": 1000, "allocation": 100, "available": 900})
            network = SimpleNamespace(inspect=lambda: {"status": "CONNECTED", "cidr": "10.20.0.0/29"})
            backend = LibvirtBackend(make_config(root), runner, state, storage, network)
            backend._external_reservations = lambda: (1, 1024)
            result = backend.host_inventory()
            self.assertEqual(result["status"], "CONNECTED")
            self.assertEqual(result["cpu_threads"], 8)
            self.assertEqual(result["memory_mib"], 8192)
            self.assertEqual(result["available_vcpus"], 6)
            self.assertEqual(result["available_memory_mib"], 6656)
            self.assertEqual(result["public_network"]["status"], "NOT CONNECTED")

    def test_host_inventory_refuses_unverified_libvirt_capacity(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            runner = FakeRunner({"nodeinfo": CommandError(("virsh",), 1, "not connected")})
            backend = LibvirtBackend(make_config(root), runner, AgentState(root / "state.db"), object(), object())
            with self.assertRaises(BackendError) as caught:
                backend.host_inventory()
            self.assertEqual(caught.exception.status, 503)

    def test_mtls_principal_must_match_configured_control_plane(self):
        with tempfile.TemporaryDirectory() as d:
            handler = object.__new__(Handler)
            handler.connection = SimpleNamespace(getpeercert=lambda: {"subject": ((("commonName", "control-plane"),),)})
            handler.server = SimpleNamespace(config=make_config(Path(d)))
            self.assertEqual(handler._principal(), "control-plane")
            handler.connection = SimpleNamespace(getpeercert=lambda: {"subject": ((("commonName", "customer"),),)})
            self.assertIsNone(handler._principal())


class ProvisionFakes:
    """Explicit unit-test doubles: no libvirt host or disk I/O is contacted."""
    def __init__(self, root: Path, fail_start: bool = False):
        self.root = root
        self.calls = []
        self.xml = ""
        self.fail_start = fail_start
        self.statuses = ["shut off"] if fail_start else ["running"]

    def run(self, *argv, **kwargs):
        self.calls.append(tuple(argv))
        if argv[0] == "qemu-img" and argv[1] == "info":
            return '{"format":"qcow2","virtual-size":10737418240}'
        if argv[0] == "qemu-img" and argv[1] == "create":
            Path(argv[-2]).write_bytes(b"test-only-overlay")
            return ""
        if argv[0] == "cloud-localds":
            Path(argv[3]).write_bytes(b"test-only-seed")
            return ""
        if argv[0] == "virsh":
            args = argv[3:]
            if args[:3] == ("list", "--all", "--name"):
                return ""
            if args[0] == "define":
                self.xml = Path(args[1]).read_text(encoding="utf-8")
                return ""
            if args[0] == "start" and self.fail_start:
                raise CommandError(argv, 1, "test double: libvirt refused start")
            if args[0] == "domstate":
                return self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
            return ""
        return ""


class ProvisionStorageFake:
    def __init__(self, root: Path):
        self.root = root
        self.created = []
        self.deleted = []
        self.uploads = []

    def verify_pool(self):
        return {"state": "running", "type": "dir"}

    def create(self, name: str, capacity_bytes: int, fmt: str = "qcow2") -> Path:
        path = self.root / name
        path.write_bytes(b"test-double-volume")
        self.created.append((name, capacity_bytes, fmt))
        return path

    def upload(self, name: str, source: Path):
        self.uploads.append(name)

    def delete(self, name: str):
        self.deleted.append(name)
        (self.root / name).unlink(missing_ok=True)

    def resize_grow_only(self, name, size):
        return None

    def inventory(self):
        return []


class ProvisionNetworkFake:
    def __init__(self):
        self.released = []

    def ensure(self):
        return {"state": "active"}

    def allocate(self, **kwargs):
        return "10.20.0.2"

    def release(self, vm_id, mac):
        self.released.append((vm_id, mac))

    def inspect(self):
        return {"status": "CONNECTED", "cidr": "10.20.0.0/29"}


class ProvisioningTests(unittest.TestCase):
    def _run_case(self, fail_start=False):
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        (root / "pool").mkdir()
        (root / "images").mkdir()
        image = root / "images" / "ubuntu-test.qcow2"
        image.write_bytes(b"fixture-base-image")
        image.chmod(0o444)
        config = make_config(root)
        state = AgentState(root / "state" / "agent.db")
        runner = ProvisionFakes(root, fail_start)
        storage, network = ProvisionStorageFake(root / "pool"), ProvisionNetworkFake()
        backend = LibvirtBackend(config, runner, state, storage, network)
        backend._capacity = lambda: (8, 16384)
        request = {
            "vm_id": str(uuid.uuid4()), "tenant_id": "tenant-test", "image": image.name,
            "vcpus": 1, "memory_mib": 512, "disk_gib": 8, "hostname": "customer-vm",
            "username": "ubuntu", "ssh_public_key": valid_ssh_key(),
        }
        return tmp, root, backend, state, runner, storage, network, request

    def test_provision_success_requires_real_adapter_confirmation_and_reports_no_public_ip(self):
        tmp, root, backend, state, runner, storage, network, request = self._run_case()
        with tmp:
            result = backend.provision(request)
            self.assertEqual(result["status"], "running")
            self.assertEqual(result["private_ipv4"], "10.20.0.2")
            self.assertIsNone(result["public_ipv4"])
            self.assertEqual(result["public_network"], "NOT CONNECTED")
            self.assertIn("cloud-localds", [call[0] for call in runner.calls])
            self.assertIn("qemu-img", [call[0] for call in runner.calls])
            self.assertIn("<domain", runner.xml)
            self.assertIn(request["vm_id"], runner.xml)
            self.assertEqual(len(storage.created), 2)
            self.assertEqual(set(storage.uploads), {"vps-" + request["vm_id"] + "-root.qcow2", "vps-" + request["vm_id"] + "-seed.iso"})
            self.assertEqual(state.vm(request["vm_id"])["status"], "running")

    def test_failed_libvirt_start_is_not_reported_as_success_and_cleanup_is_attempted(self):
        tmp, root, backend, state, runner, storage, network, request = self._run_case(fail_start=True)
        with tmp:
            with self.assertRaises(BackendError):
                backend.provision(request)
            self.assertEqual(state.vm(request["vm_id"]), None)
            self.assertEqual(len(storage.deleted), 2)
            self.assertEqual(len(network.released), 1)
            self.assertIn("undefine", [call[3] for call in runner.calls if len(call) > 3])

    def test_fractional_resource_request_is_rejected_without_host_operations(self):
        tmp, root, backend, state, runner, storage, network, request = self._run_case()
        with tmp:
            request["vcpus"] = 1.5
            with self.assertRaises(BackendError) as caught:
                backend.provision(request)
            self.assertEqual(caught.exception.status, 400)
            self.assertEqual(runner.calls, [])

    def test_per_vm_resource_limit_rejected_before_host_operations(self):
        tmp, root, backend, state, runner, storage, network, request = self._run_case()
        with tmp:
            request["vcpus"] = 1000
            with self.assertRaises(BackendError):
                backend.provision(request)
            self.assertEqual(runner.calls, [])


if __name__ == "__main__":
    unittest.main()
