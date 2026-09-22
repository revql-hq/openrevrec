"""Thin loopback HTTP adapter. All accounting behavior belongs to Application."""

from __future__ import annotations

import io
import json
import secrets
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.utils import secure_filename

from . import __version__
from .application import Application
from .demo import load_demo
from .interchange import export_bytes, import_bytes, template_bytes
from .workspace import identifier, now


def create_app(application: Application, token=None, static_dir=None):
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
    static = Path(static_dir).resolve() if static_dir else None

    @app.before_request
    def local_access():
        if urlparse(request.host_url).hostname not in {"127.0.0.1", "localhost", "::1"}:
            return jsonify(error="OpenRevRec accepts local connections only."), 403
        if request.path.startswith("/api/"):
            if token and request.path != "/api/health":
                provided = request.headers.get("Authorization", "").removeprefix("Bearer ")
                if not secrets.compare_digest(provided.encode(), token.encode()):
                    return jsonify(error="Local session authorization is required."), 401
            origin = request.headers.get("Origin")
            if origin and urlparse(origin).hostname not in {"localhost", "127.0.0.1", "::1"}:
                return jsonify(error="Requests must originate from the local workbench."), 403

    @app.errorhandler(ValueError)
    def validation_error(exc):
        return jsonify(error=str(exc)), 400

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return jsonify(error=exc.description), exc.code

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", version=__version__)

    @app.get("/api/state")
    def state():
        return jsonify(application.state(request.args.get("scenario_id", "main"), request.args.get("period")))

    @app.get("/api/workspace")
    def workspace():
        with application.workspace.connect() as db:
            return jsonify({**application.workspace.metadata(db), "path": str(application.workspace.path)})

    def envelope():
        data = request.get_json()
        if not isinstance(data, dict) or not isinstance(data.get("command"), str) or not isinstance(data.get("payload", {}), dict):
            raise ValueError("Provide command and payload in a JSON object.")
        return {"command": data["command"], "payload": data.get("payload", {}), "scenario_id": data.get("scenario_id", "main"), "period": data.get("period"), "idempotency_key": data.get("idempotency_key")}

    @app.post("/api/commands")
    def command():
        return jsonify(application.execute(**envelope(), source="desktop"))

    @app.post("/api/preview")
    def preview():
        return jsonify(application.preview(**envelope()))

    @app.get("/api/compare")
    def compare():
        return jsonify(application.compare(request.args.get("scenario_id", "main"), request.args.get("period")))

    @app.get("/api/reports")
    def reports():
        return jsonify(application.reports(request.args.get("scenario_id", "main"), request.args.get("period")))

    @app.get("/api/changes/<change_set_id>")
    def change_detail(change_set_id):
        return jsonify(application.change_detail(change_set_id, request.args.get("period")))

    @app.get("/api/template")
    def template():
        return send_file(io.BytesIO(template_bytes()), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", as_attachment=True, download_name="OpenRevRec-import-template.xlsx")

    @app.get("/api/export")
    def export():
        bundle = application.report_bundle(request.args.get("scenario_id", "main"), request.args.get("period"))
        state = bundle["state"]
        filename = secure_filename(f"OpenRevRec-{state['report']['period']}-{state['scenario_id']}.xlsx")
        return send_file(io.BytesIO(export_bytes(state, bundle["review"])), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", as_attachment=True, download_name=filename)

    @app.post("/api/import")
    def import_workbook():
        file = request.files.get("file")
        if not file or not file.filename.lower().endswith(".xlsx"):
            raise ValueError("Choose an .xlsx import workbook.")
        name = secure_filename(file.filename) or "import.xlsx"
        data = file.read()
        # Retain source and row outcome independently of the all-or-nothing accounting import.
        import_id = identifier("import")
        folder = application.workspace.path / "attachments" / import_id
        folder.mkdir()
        (folder / name).write_bytes(data)
        result_path = folder / "result.json"
        try:
            response = import_bytes(application, data, name, request.form.get("scenario_id", "main"), request.form.get("period"))
            result_path.write_text(json.dumps({"id": import_id, "source": name, "recorded_at": now(), "status": "accepted", **response["result"]}, indent=2))
            return jsonify(response)
        except ValueError as exc:
            result_path.write_text(json.dumps({"id": import_id, "source": name, "recorded_at": now(), "status": "rejected", "error": str(exc)}, indent=2))
            raise

    @app.get("/api/imports")
    def imports():
        records = []
        for file in application.workspace.path.glob("attachments/import_*/result.json"):
            records.append(json.loads(file.read_text()))
        return jsonify(imports=sorted(records, key=lambda r: r["recorded_at"], reverse=True))

    @app.post("/api/demo")
    def demo():
        return jsonify(load_demo(application))

    @app.post("/api/sql")
    def sql():
        data = request.get_json()
        if not isinstance(data, dict):
            raise ValueError("Provide query in a JSON object.")
        return jsonify(application.query(data.get("query")))

    @app.get("/api/search")
    def search():
        query = request.args.get("q", "").casefold().strip()
        state = application.state(request.args.get("scenario_id", "main"), request.args.get("period"))
        found = []
        def add(kind, id, name, **extra):
            if query in str(name).casefold() or query in id.casefold():
                found.append({"type": kind, "id": id, "name": name, "entity_id": id, **extra})
        for c in state["customers"]:
            add("customer", c["id"], c["name"])
        for c in state["contracts"]:
            add("contract", c["id"], c["name"], contract_id=c["id"])
            for o in c["obligations"]:
                add("obligation", o["id"], o["name"], contract_id=c["id"])
            for event in c["activities"]:
                if event.get("reference"):
                    add("billing" if event["type"] == "billing" else "activity", event["id"], event["reference"], contract_id=c["id"])
        for s in state["scenarios"]:
            add("scenario", s["id"], s["name"])
        for n in state["notes"]:
            add(n["kind"], n["id"], n["body"], contract_id=n.get("entity_id"))
        for n in state["evidence"]:
            add("document", n["id"], n["name"], contract_id=n.get("entity_id"))
        return jsonify(results=found[:50])

    @app.post("/api/evidence")
    def evidence():
        file = request.files.get("file")
        if not file:
            raise ValueError("Choose an evidence file.")
        name = secure_filename(file.filename or "evidence") or "evidence"
        relative = Path("attachments") / f"{identifier('doc')}-{name}"
        full_path = application.workspace.path / relative
        file.save(full_path)
        try:
            payload = {"name": file.filename or name, "path": relative.as_posix(), "rationale": request.form.get("rationale", "")}
            payload.update({key: request.form[key] for key in ("entity_id", "target_change_set_id", "obligation_id", "period_close_id") if request.form.get(key)})
            return jsonify(application.execute("attach_evidence", payload, scenario_id=request.form.get("scenario_id", "main"), period=request.form.get("period"), source="desktop"))
        except Exception:
            full_path.unlink(missing_ok=True)
            raise

    @app.get("/api/evidence/<evidence_id>")
    def get_evidence(evidence_id):
        state = application.state(request.args.get("scenario_id", "main"))
        doc = next((e for e in state["evidence"] if e["id"] == evidence_id), None)
        if not doc:
            raise ValueError("Evidence was not found.")
        attachment = application.workspace.evidence_path(doc["path"])
        return send_file(attachment, as_attachment=True, download_name=doc["name"])

    @app.get("/")
    @app.get("/<path:path>")
    def frontend(path=""):
        if path == "api" or path.startswith("api/"):
            return jsonify(error="API endpoint was not found."), 404
        if static and static.is_dir():
            candidate = (static / path).resolve()
            if path and candidate.is_relative_to(static) and candidate.is_file():
                return send_from_directory(static, path)
            return send_from_directory(static, "index.html")
        return jsonify(name="OpenRevRec", version=__version__, message="Start the frontend with npm run dev.")

    return app
