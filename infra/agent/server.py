from __future__ import annotations

import json
import re
import ssl
import threading
import time
import uuid
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .config import Config
from .libvirt_backend import BackendError, LibvirtBackend
from .network import NetworkError, PublicNetworkNotConnected
from .runner import CommandError, CommandRunner
from .state import AgentState, StateConflict
from .storage import SafeStorage, StorageError

_MAX_BODY = 128 * 1024
_IDEMPOTENCY = re.compile(r"^[0-9a-fA-F-]{36}$")


class AgentHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, handler, config, backend, state):
        super().__init__(address, handler)
        self.config, self.backend, self.state = config, backend, state
        self.rate_lock = threading.Lock()
        self.rate = defaultdict(deque)
        self.mutation_lock = threading.RLock()

    def allow(self, principal: str) -> bool:
        now = time.monotonic()
        with self.rate_lock:
            hits = self.rate[principal]
            while hits and hits[0] <= now - 60:
                hits.popleft()
            if len(hits) >= 60:
                return False
            hits.append(now)
            return True


class Handler(BaseHTTPRequestHandler):
    server: AgentHTTPServer
    protocol_version = "HTTP/1.1"
    sys_version = "VPSHostAgent"

    def log_message(self, fmt, *args):
        # Never log request bodies, SSH keys, or certificate material.
        print("host-agent", self.address_string(), fmt % args)

    def _principal(self) -> str | None:
        cert = self.connection.getpeercert()
        subject = cert.get("subject", ())
        pairs = {key: value for group in subject for key, value in group}
        cn = pairs.get("commonName")
        return cn if cn == self.server.config.controller_cn else None

    def _respond(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> tuple[bytes, dict]:
        if self.headers.get("Transfer-Encoding"):
            raise BackendError("chunked request bodies are not supported", 400)
        raw_length = self.headers.get("Content-Length", "0")
        if not raw_length.isdigit() or int(raw_length) > _MAX_BODY:
            raise BackendError("request body exceeds the limit", 413)
        raw = self.rfile.read(int(raw_length)) if int(raw_length) else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=self._unique_object)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise BackendError("request body must be valid JSON without duplicate keys", 400) from exc
        if not isinstance(value, dict):
            raise BackendError("request JSON must be an object", 400)
        return raw, value

    @staticmethod
    def _unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def _dispatch(self, method: str, path: str, body: dict, principal: str) -> tuple[int, dict]:
        backend = self.server.backend
        if method == "GET" and path == "/v1/health":
            return 200, {"status": "ok", "host_id": self.server.config.host_id, "agent": "IMPLEMENTED", "libvirt": "local command checks required", "public_network": "NOT CONNECTED"}
        if method == "GET" and path == "/v1/capabilities":
            return 200, {"host_id": self.server.config.host_id, "vm_lifecycle": "libvirt adapter implemented; host connection is checked by /v1/host", "storage": "operator-created directory pool only", "private_network": "libvirt NAT with static DHCP reservations", "public_network": backend.public_network_status()}
        if method == "GET" and path == "/v1/host":
            return 200, backend.host_inventory()
        if method == "GET" and path == "/v1/audit":
            query = parse_qs(urlparse(self.path).query, strict_parsing=False)
            try:
                limit = int(query.get("limit", ["100"])[0])
            except ValueError as exc:
                raise BackendError("limit must be an integer", 400) from exc
            return 200, {"events": self.server.state.recent_audit(limit)}
        if method == "GET" and path == "/v1/network":
            result = backend.network.inspect()
            return (200 if result["status"] == "CONNECTED" else 503), {"private": result, "public": backend.public_network_status()}
        if method == "GET" and path == "/v1/storage/volumes":
            try:
                return 200, {"pool": self.server.config.storage_pool, "capacity": backend.storage.pool_capacity(), "volumes": backend.storage.inventory()}
            except (StorageError, CommandError) as exc:
                return 503, {"error": "STORAGE_NOT_READY", "message": str(exc)}
        if method == "POST" and path == "/v1/vms":
            result = backend.provision(body)
            return 201, result
        resize = re.fullmatch(r"/v1/vms/([0-9a-fA-F-]{36})/disk/resize", path)
        if method == "POST" and resize:
            return 200, backend.resize_disk(resize.group(1), body.get("tenant_id", ""), body.get("disk_gib"))
        match = re.fullmatch(r"/v1/vms/([0-9a-fA-F-]{36})", path)
        if method == "GET" and match:
            return 200, backend.get_vm(match.group(1), body.get("tenant_id", ""))
        if method == "DELETE" and match:
            return 200, backend.delete_vm(match.group(1), body.get("tenant_id", ""))
        lifecycle = re.fullmatch(r"/v1/vms/([0-9a-fA-F-]{36})/(start|shutdown|reboot)", path)
        if method == "POST" and lifecycle:
            return 200, backend.lifecycle(lifecycle.group(1), body.get("tenant_id", ""), lifecycle.group(2))
        if method == "POST" and path == "/v1/network/public/allocate":
            raise PublicNetworkNotConnected("public IP allocation is NOT CONNECTED: operator upstream routing must be integrated and verified")
        return 404, {"error": "NOT_FOUND", "message": "unknown host-agent endpoint"}

    def _handle(self, method: str) -> None:
        principal = self._principal()
        if principal is None:
            self._respond(403, {"error": "FORBIDDEN", "message": "trusted control-plane client certificate required"})
            return
        if not self.server.allow(principal):
            self._respond(429, {"error": "RATE_LIMITED", "message": "host-agent request limit exceeded"})
            return
        parsed = urlparse(self.path)
        path = parsed.path
        if method == "GET":
            try:
                payload = {}
                if path.startswith("/v1/vms/"):
                    query = parse_qs(parsed.query, strict_parsing=False)
                    payload["tenant_id"] = query.get("tenant_id", [""])[0]
                status, response = self._dispatch(method, path, payload, principal)
                self._respond(status, response)
            except (BackendError, StateConflict, StorageError, NetworkError) as exc:
                status = exc.status if isinstance(exc, BackendError) else 409
                self._respond(status, {"error": type(exc).__name__.upper(), "message": str(exc)})
            except CommandError:
                self._respond(502, {"error": "HOST_COMMAND_FAILED", "message": "host operation failed; inspect operator logs"})
            return
        if method not in {"POST", "PUT", "PATCH", "DELETE"}:
            self._respond(405, {"error": "METHOD_NOT_ALLOWED"})
            return
        try:
            raw, payload = self._body()
            key = self.headers.get("Idempotency-Key", "")
            try:
                canonical_key = str(uuid.UUID(key))
            except (ValueError, AttributeError) as exc:
                raise BackendError("mutating requests require a UUID Idempotency-Key", 400) from exc
            if not _IDEMPOTENCY.fullmatch(key) or canonical_key != key.lower():
                raise BackendError("mutating requests require a UUID Idempotency-Key", 400)
            digest, cached = self.server.state.idempotency_begin(key, method, path, raw)
            if cached is not None:
                self._respond(cached["status"], cached["body"])
                return
            with self.server.mutation_lock:
                try:
                    status, response = self._dispatch(method, path, payload, principal)
                except PublicNetworkNotConnected as exc:
                    status, response = 501, {"error": "PUBLIC_NETWORK_NOT_CONNECTED", "message": str(exc)}
                except BackendError as exc:
                    status, response = exc.status, {"error": "REQUEST_FAILED", "message": str(exc)}
                except StateConflict as exc:
                    status, response = 409, {"error": "STATE_CONFLICT", "message": str(exc)}
                except (StorageError, NetworkError) as exc:
                    status, response = 503, {"error": "INFRASTRUCTURE_NOT_READY", "message": str(exc)}
                except CommandError:
                    status, response = 502, {"error": "HOST_COMMAND_FAILED", "message": "host operation failed; inspect operator logs"}
                except Exception as exc:
                    print("host-agent internal failure", type(exc).__name__)
                    status, response = 500, {"error": "INTERNAL_ERROR", "message": "operation failed; inspect operator logs"}
                self.server.state.idempotency_finish(key, digest, {"status": status, "body": response})
                self.server.state.audit(principal, method + " " + path, payload.get("vm_id") or path, "ok" if status < 400 else "failed", response.get("error", ""))
            self._respond(status, response)
        except BackendError as exc:
            self._respond(exc.status, {"error": "REQUEST_FAILED", "message": str(exc)})
        except StateConflict as exc:
            self._respond(409, {"error": "STATE_CONFLICT", "message": str(exc)})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")


def build_server(config: Config, runner=None, state=None):
    config.validate_paths()
    runner = runner or CommandRunner(config.command_timeout)
    state = state or AgentState(config.state_path)
    storage = SafeStorage(runner, config.storage_pool, config.storage_path, config.libvirt_uri)
    from .network import PrivateNetwork
    network = PrivateNetwork(runner, state, name=config.private_network, cidr=config.private_cidr, gateway=config.private_gateway, dhcp_start=config.dhcp_start, dhcp_end=config.dhcp_end, bridge=config.bridge, allow_create=config.allow_network_create, uri=config.libvirt_uri)
    backend = LibvirtBackend(config, runner, state, storage, network)
    server = AgentHTTPServer((config.bind_host, config.port), Handler, config, backend, state)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_cert_chain(str(config.server_cert), str(config.server_key))
    context.load_verify_locations(cafile=str(config.client_ca))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    return server


def main():
    config = Config.from_env()
    server = build_server(config)
    print(f"host-agent listening with mandatory mTLS on {config.bind_host}:{config.port}; host_id={config.host_id}; public_network=NOT_CONNECTED", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
