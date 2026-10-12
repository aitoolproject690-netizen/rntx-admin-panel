# KVM host preflight (read-only)

This check verifies local prerequisites for the operator-managed KVM host agent. The agent implements real libvirt VM/storage/private-network operations, but does not connect a host to the RNTX control plane by itself.

## Supported preflight targets

- Ubuntu 22.04 or 24.04; Debian 12 or 13.
- x86_64 (Intel VT-x or AMD-V exposed to Linux) or aarch64 with KVM virtualization support.
- A readable and writable /dev/kvm device, architecture-matching QEMU binary, and a reachable qemu:///system libvirt service.

## Run

    python3 infra/kvm/preflight.py

Exit code 0 means only that every local prerequisite above passed; exit code 2 means one or more checks are blocked. The JSON report labels the control plane, VM provisioning, storage pools, and public networking as NOT CONNECTED; it labels the host-agent code as IMPLEMENTED — NOT CONNECTED; host registration and application integration remain unimplemented. A green local preflight is not an operational host or a successful VM deployment.

The probe is read-only: it reads /etc/os-release, /proc/cpuinfo and /dev/kvm access, locates binaries, and executes only virsh --readonly -c qemu:///system nodeinfo. It does not install packages, load kernel modules, download images, create networks or storage pools, format disks, change firewall rules, or assign IP addresses. Disk inventory is intentionally not included until a separately reviewed safe-storage workflow exists.

If prerequisites are missing, an operator can review the distribution's official package instructions for QEMU and libvirt, enable CPU virtualization in firmware/provider settings, and configure access to /dev/kvm. This repository does not run sudo commands or install anything automatically. Do not use this control-plane app as a hypervisor; install the host agent only on an operator-managed Linux compute node.

## Automated tests

    python3 -m unittest discover -s infra/kvm/tests -v

Tests use explicit simulated host facts. They do not claim that a physical or virtual KVM host is available.
