from __future__ import annotations

import subprocess
from typing import Sequence


class CommandError(RuntimeError):
    def __init__(self, argv: Sequence[str], returncode: int | None, detail: str):
        self.argv = tuple(argv)
        self.returncode = returncode
        self.detail = detail[:400]
        super().__init__(f"{argv[0]} failed: {self.detail}")


class CommandRunner:
    """Execute fixed-argument host tools; never invokes a shell."""

    def __init__(self, timeout: int = 30):
        self.timeout = timeout

    def run(self, *argv: str, timeout: int | None = None) -> str:
        if not argv or any(not isinstance(arg, str) or "\x00" in arg for arg in argv):
            raise ValueError("invalid command arguments")
        try:
            result = subprocess.run(
                list(argv), capture_output=True, text=True, check=False,
                timeout=timeout or self.timeout, close_fds=True,
            )
        except subprocess.TimeoutExpired as exc:
            raise CommandError(argv, None, "command timed out") from exc
        except OSError as exc:
            raise CommandError(argv, None, str(exc)) from exc
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
            raise CommandError(argv, result.returncode, detail)
        return result.stdout.strip()
