"""Exercise a frozen native backend from an unrelated working directory."""

import argparse
import io
import json
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    executable = args.executable or root / "dist" / "openrevrec-server" / ("openrevrec-server.exe" if sys.platform == "win32" else "openrevrec-server")
    executable = executable.resolve()
    if not executable.is_file():
        parser.error("Native backend is missing. Run npm run build:backend first.")
    token = secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix="OpenRevRec smoke ") as temporary:
        workspace = Path(temporary) / "Test company.orr"
        stderr_path = Path(temporary) / "backend.log"
        with stderr_path.open("w+") as errors:
            process = subprocess.Popen(
                [str(executable), "serve", "--workspace", str(workspace), "--port", "0", "--token", token, "--static-dir", str(root / "frontend" / "dist")],
                cwd=temporary, stdout=subprocess.PIPE, stderr=errors, text=True,
            )
            lines = queue.Queue()

            def read_output():
                for line in process.stdout:
                    lines.put(line)
                lines.put(None)

            threading.Thread(target=read_output, daemon=True).start()
            try:
                while True:
                    line = lines.get(timeout=40)
                    if line is None:
                        errors.seek(0)
                        raise RuntimeError(f"Backend exited before readiness: {errors.read()}")
                    try:
                        ready = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if ready.get("port"):
                        break
                origin = f"http://127.0.0.1:{ready['port']}"

                def request(route, payload=None, authenticate=True):
                    headers = {"Authorization": f"Bearer {token}"} if authenticate else {}
                    data = None
                    if payload is not None:
                        data = json.dumps(payload).encode()
                        headers["Content-Type"] = "application/json"
                    with urllib.request.urlopen(urllib.request.Request(origin + route, data=data, headers=headers), timeout=15) as response:
                        return response.read()

                request("/api/health")
                try:
                    request("/api/state", authenticate=False)
                    raise AssertionError("Unauthenticated API request was accepted")
                except urllib.error.HTTPError as error:
                    assert error.code == 401, error.code
                request("/api/demo", {})
                state = json.loads(request("/api/state?period=2026-09"))
                assert len(state["contracts"]) == 5, "Demo contracts were not persisted"
                reports = json.loads(request("/api/reports?period=2026-09"))
                assert reports["checks"] and len(reports["rollforward"]) == 5, "Prebuilt reports were not calculated"
                assert reports["scenario_impacts"], "Scenario impact report is missing"
                workbook = request("/api/export?period=2026-09")
                assert zipfile.is_zipfile(io.BytesIO(workbook)), "Excel export is not a workbook"
                request("/api/template")
                assert b"OpenRevRec" in request("/"), "Packaged frontend was not served"
                assert (workspace / "workspace.sqlite3").is_file()
                print(f"Frozen backend smoke passed: 5 contracts, prebuilt reports, authenticated API, Excel export, template, static UI; {sys.platform}.")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()


if __name__ == "__main__":
    main()
