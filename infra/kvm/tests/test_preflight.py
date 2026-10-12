import unittest

from infra.kvm.preflight import assess, parse_os_release


class ParseOSReleaseTests(unittest.TestCase):
    def test_parses_quoted_fields_without_shell_evaluation(self):
        parsed = parse_os_release('ID=ubuntu\nVERSION_ID="24.04"\nNAME="Ubuntu $(touch /tmp/not-run)"\n')
        self.assertEqual(parsed["ID"], "ubuntu")
        self.assertEqual(parsed["VERSION_ID"], "24.04")
        self.assertIn("$(touch /tmp/not-run)", parsed["NAME"])


class KvmPreflightTests(unittest.TestCase):
    def ready_report(self, **overrides):
        args = {
            "system_name": "Linux",
            "architecture": "x86_64",
            "os_release": {"ID": "ubuntu", "VERSION_ID": "24.04"},
            "cpuinfo": "processor : 0\nflags : fpu vmx sse4_2\n",
            "kvm_exists": True,
            "kvm_read_write": True,
            "qemu_binary": "/usr/bin/qemu-system-x86_64",
            "virsh_binary": "/usr/bin/virsh",
            "libvirt_connected": True,
        }
        args.update(overrides)
        return assess(**args)

    def test_ready_host_does_not_claim_control_plane_or_vms(self):
        report = self.ready_report()
        self.assertEqual(report["host_preflight"], "READY")
        self.assertEqual(report["integrations"]["local_libvirt"], "CONNECTED")
        self.assertEqual(report["integrations"]["control_plane"], "NOT CONNECTED")
        self.assertEqual(report["integrations"]["host_agent"], "IMPLEMENTED — NOT CONNECTED")
        self.assertEqual(report["integrations"]["vm_provisioning"], "NOT CONNECTED")
        self.assertTrue(report["read_only"])

    def test_missing_kvm_device_blocks(self):
        report = self.ready_report(kvm_exists=False, kvm_read_write=False)
        self.assertEqual(report["host_preflight"], "BLOCKED")
        self.assertEqual(report["checks"]["kvm_device"]["status"], "FAIL")

    def test_missing_cpu_virtualization_flag_blocks(self):
        report = self.ready_report(cpuinfo="processor : 0\nflags : fpu sse4_2\n")
        self.assertEqual(report["host_preflight"], "BLOCKED")
        self.assertEqual(report["checks"]["cpu_virtualization"]["status"], "FAIL")

    def test_unsupported_os_blocks(self):
        report = self.ready_report(os_release={"ID": "ubuntu", "VERSION_ID": "20.04"})
        self.assertEqual(report["checks"]["supported_os"]["status"], "FAIL")

    def test_disconnected_libvirt_blocks(self):
        report = self.ready_report(libvirt_connected=False, libvirt_error="permission denied")
        self.assertEqual(report["checks"]["libvirt"]["status"], "FAIL")
        self.assertEqual(report["integrations"]["local_libvirt"], "NOT CONNECTED")

    def test_aarch64_uses_architecture_specific_qemu_and_feature(self):
        report = self.ready_report(
            architecture="aarch64",
            cpuinfo="processor : 0\nFeatures : fp asimd virt\n",
            qemu_binary="/usr/bin/qemu-system-aarch64",
        )
        self.assertEqual(report["host_preflight"], "READY")
        self.assertEqual(report["host"]["architecture"], "aarch64")

    def test_non_linux_never_passes(self):
        report = self.ready_report(system_name="Darwin")
        self.assertEqual(report["host_preflight"], "BLOCKED")
        self.assertEqual(report["checks"]["linux"]["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
