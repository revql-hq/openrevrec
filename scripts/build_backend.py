"""Build a native one-directory backend bundle on the current operating system."""

from pathlib import Path
import os
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
subprocess.run(
    [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "openrevrec-server", "--paths", str(root / "src"),
        "--collect-all", "openrevrec", "--distpath", str(root / "dist"),
        "--workpath", str(root / "build" / "pyinstaller"),
        "--specpath", str(root / "build"), str(root / "scripts" / "server_entry.py"),
    ],
    cwd=root,
    check=True,
    env={**os.environ, "PYINSTALLER_CONFIG_DIR": str(root / "build" / "pyinstaller-config")},
)
