from __future__ import annotations

import io
import json
import zipfile
import pytest
from openpyxl import load_workbook

from openrevrec.api import create_app
from openrevrec.application import Application
from openrevrec.interchange import template_bytes


def client(tmp_path, token="secret", static_dir=None):
    application = Application.create(tmp_path / "API.orr", "API company")
    web = create_app(application, token=token, static_dir=static_dir)
    web.config.update(TESTING=True)
    return web.test_client(), application


def test_api_requires_session_token_and_rejects_remote_origin(tmp_path):
    web, _ = client(tmp_path)
    assert web.get("/api/health").status_code == 200
    assert web.get("/api/state").status_code == 401
    headers = {"Authorization": "Bearer secret"}
    assert web.get("/api/state", headers=headers).status_code == 200
    assert web.get("/api/state", headers={**headers, "Origin": "https://example.com"}).status_code == 403


def test_command_preview_search_sql_and_demo_routes(tmp_path):
    web, application = client(tmp_path)
    headers = {"Authorization": "Bearer secret"}
    demo = web.post("/api/demo", json={}, headers=headers)
    assert demo.status_code == 200
    assert demo.get_json()["result"]["contracts"] == 5
    state = web.get("/api/state?period=2026-09", headers=headers).get_json()
    before = state["frontier"]
    preview = web.post("/api/preview", json={"command": "record_billing", "payload": {"contract_id": "con_saas", "effective_date": "2026-10-01", "amount": "1.00"}, "period": "2026-10"}, headers=headers)
    assert preview.status_code == 200
    assert application.state(period="2026-10")["frontier"] == before
    assert web.get("/api/search?q=Northstar", headers=headers).get_json()["results"]
    query = web.post("/api/sql", json={"query": "SELECT count(*) AS count FROM contracts"}, headers=headers).get_json()
    assert query["rows"] == [[5]]
    reports = web.get("/api/reports?period=2026-09", headers=headers).get_json()
    assert reports["checks"]
    assert len(reports["rollforward"]) == 5
    assert reports["scenario_impacts"][0]["affected_periods"]
    judgment = next(row for row in state["change_sets"] if row["command"] == "reassess_variable_consideration")
    detail = web.get(f"/api/changes/{judgment['id']}?period=2026-09", headers=headers).get_json()
    assert detail["change"]["id"] == judgment["id"]
    assert detail["comparison"]["summary"]["revenue"] == "300.00"
    assert web.get("/api/export?period=2026-09", headers=headers).data.startswith(b"PK")
    assert web.get("/api/template", headers=headers).data.startswith(b"PK")


def test_command_route_enforces_preview_version(tmp_path):
    web, application = client(tmp_path)
    headers = {"Authorization": "Bearer secret"}
    command = {"command": "create_customer", "payload": {"name": "Reviewed customer"}}
    preview = web.post("/api/preview", json=command, headers=headers).get_json()
    application.execute("create_customer", {"name": "Intervening customer"})
    stale = web.post("/api/commands", json={**command, "expected_frontier": preview["frontier"],
                                          "expected_request_hash": preview["request_hash"]}, headers=headers)
    assert stale.status_code == 400
    assert "changed since preview" in stale.get_json()["error"]
    assert [customer["name"] for customer in application.state()["customers"]] == ["Intervening customer"]


def test_static_app_and_json_errors(tmp_path):
    static = tmp_path / "ui"; static.mkdir(); (static / "index.html").write_text("<main>OpenRevRec UI</main>")
    web, _ = client(tmp_path, static_dir=static)
    headers = {"Authorization": "Bearer secret"}
    assert b"OpenRevRec UI" in web.get("/").data
    response = web.post("/api/commands", json={"command": "not_real", "payload": {}}, headers=headers)
    assert response.status_code == 400
    assert "Unknown command" in response.get_json()["error"]


def test_import_route_requires_reviewed_file_and_workspace_frontier(tmp_path):
    web, application = client(tmp_path)
    headers = {"Authorization": "Bearer secret"}
    book = load_workbook(io.BytesIO(template_bytes()))
    book["Customers"].append(["cus_import", "Imported customer", "", "CRM-1", "CRM"])
    data = io.BytesIO(); book.save(data); book.close()
    source = data.getvalue()
    review = web.post("/api/import/preview", data={"file": (io.BytesIO(source), "customers.xlsx"), "period": "2026-09"}, headers=headers, content_type="multipart/form-data")
    assert review.status_code == 200
    assert application.state(period="2026-09")["customers"] == []
    unreviewed = web.post("/api/import", data={"file": (io.BytesIO(source), "customers.xlsx"), "period": "2026-09"}, headers=headers, content_type="multipart/form-data")
    assert unreviewed.status_code == 400
    preview = review.get_json()
    accepted = web.post("/api/import", data={"file": (io.BytesIO(source), "customers.xlsx"), "period": "2026-09", "expected_hash": preview["result"]["file_hash"], "expected_frontier": str(preview["frontier"])}, headers=headers, content_type="multipart/form-data")
    assert accepted.status_code == 200
    assert application.state(period="2026-09")["customers"][0]["reference"] == "CRM-1"
    duplicate = web.post("/api/import", data={"file": (io.BytesIO(source), "customers.xlsx"), "period": "2026-09", "expected_hash": preview["result"]["file_hash"], "expected_frontier": str(application.state(period="2026-09")["frontier"])}, headers=headers, content_type="multipart/form-data")
    assert duplicate.status_code == 400
    rejected = next(row for row in web.get("/api/imports", headers=headers).get_json()["imports"] if row["status"] == "rejected")
    errors = web.get(f"/api/imports/{rejected['id']}/errors.csv", headers=headers)
    assert errors.status_code == 200
    assert b"Customers,2" in errors.data


def test_evidence_upload_is_linked_and_downloadable(tmp_path):
    web, _ = client(tmp_path)
    headers = {"Authorization": "Bearer secret"}
    customer = web.post("/api/commands", json={"command": "create_customer", "payload": {"name": "Evidence customer"}}, headers=headers).get_json()
    customer_id = customer["result"]["id"]
    upload = web.post("/api/evidence", data={
        "file": (io.BytesIO(b"signed agreement"), "agreement.txt"),
        "entity_id": customer_id,
        "scenario_id": "main",
        "rationale": "Executed contract",
    }, headers=headers, content_type="multipart/form-data")
    assert upload.status_code == 200
    state = web.get("/api/state", headers=headers).get_json()
    document = state["evidence"][0]
    assert document["entity_id"] == customer_id
    assert document["rationale"] == "Executed contract"
    downloaded = web.get(f"/api/evidence/{document['id']}", headers=headers)
    assert downloaded.status_code == 200
    assert downloaded.data == b"signed agreement"
    reuse = web.post("/api/evidence/reuse", json={"evidence_id": document["id"], "entity_id": customer_id, "rationale": "Same signed agreement supports the legal entity record."}, headers=headers)
    assert reuse.status_code == 200
    linked = web.get("/api/state", headers=headers).get_json()["evidence"]
    assert len(linked) == 2
    assert linked[0]["path"] == linked[1]["path"]
    assert linked[0]["id"] != linked[1]["id"]
    package_response = web.get("/api/export-package?period=2026-09", headers=headers)
    assert package_response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(package_response.data)) as package:
        assert package.read(document["path"]) == b"signed agreement"
        assert package.read("OpenRevRec-support.xlsx")[:2] == b"PK"
        manifest = json.loads(package.read("manifest.json"))
        assert len(manifest["evidence"]) == 2
        assert len(manifest["files_sha256"]) == 1


def test_evidence_upload_is_traceable_but_review_clears_judgment_item(tmp_path):
    web, _ = client(tmp_path)
    headers = {"Authorization": "Bearer secret"}
    web.post("/api/demo", json={}, headers=headers)
    before = web.get("/api/reports?period=2026-09", headers=headers).get_json()
    judgment = before["exceptions"]["evidence"][0]
    response = web.post("/api/evidence", data={
        "file": (io.BytesIO(b"reviewed calculation"), "calculation.txt"),
        "entity_id": judgment["entity_id"],
        "target_change_set_id": judgment["change_set_id"],
        "scenario_id": "main",
    }, headers=headers, content_type="multipart/form-data")
    assert response.status_code == 200
    after = web.get("/api/reports?period=2026-09", headers=headers).get_json()
    assert judgment["change_set_id"] in {row["change_set_id"] for row in after["exceptions"]["evidence"]}
    detail = web.get(f"/api/changes/{judgment['change_set_id']}?period=2026-09", headers=headers).get_json()
    assert detail["evidence"][0]["name"] == "calculation.txt"
    recorded = web.post("/api/commands", json={"command": "record_judgment_review", "scenario_id": "main", "period": "2026-09", "payload": {
        "target_change_set_id": judgment["change_set_id"], "reviewer": "Accountant", "disposition": "supported",
        "conclusion": "Terms support the recorded treatment", "support_memo": "Reviewed calculation and signed terms",
    }}, headers=headers)
    assert recorded.status_code == 200
    final = web.get("/api/reports?period=2026-09", headers=headers).get_json()
    assert judgment["change_set_id"] not in {row["change_set_id"] for row in final["exceptions"]["evidence"]}


@pytest.mark.parametrize("route,payload", [
    ("/api/sql", ["SELECT 1"]),
    ("/api/commands", {"command": "create_customer", "payload": {"name": "Name"}, "scenario_id": []}),
    ("/api/commands", {"command": "create_customer", "payload": {"name": "Name"}, "idempotency_key": []}),
    ("/api/commands", {"command": "set_policy", "payload": {"accounts": []}}),
    ("/api/preview", {"command": "create_customer", "payload": {"id": 42, "name": "Name"}}),
])
def test_invalid_requests_return_json_validation_errors(tmp_path, route, payload):
    web, _ = client(tmp_path)
    response = web.post(route, json=payload, headers={"Authorization": "Bearer secret"})
    assert response.status_code == 400
    assert response.get_json()["error"]


def test_unknown_api_routes_do_not_return_frontend_html(tmp_path):
    static = tmp_path / "ui"
    static.mkdir()
    (static / "index.html").write_text("<main>UI</main>")
    web, _ = client(tmp_path, static_dir=static)
    response = web.get("/api/typo", headers={"Authorization": "Bearer secret"})
    assert response.status_code == 404
    assert response.get_json()["error"]


def test_local_host_parsing_and_non_ascii_token(tmp_path):
    web, _ = client(tmp_path)
    assert web.get("/api/health", base_url="http://[::1]:4318").status_code == 200
    assert web.get("/api/health", base_url="http://example.com").status_code == 403
    assert web.get("/api/state", headers={"Authorization": "Bearer sécret"}).status_code == 401


def test_evidence_download_revalidates_attachment_path(tmp_path):
    web, application = client(tmp_path)
    headers = {"Authorization": "Bearer secret"}
    response = web.post("/api/evidence", data={"file": (io.BytesIO(b"evidence"), "file.txt")}, headers=headers)
    evidence = response.get_json()["state"]["evidence"][0]
    attachment = application.workspace.path / evidence["path"]
    attachment.unlink()
    outside = tmp_path / "outside.txt"
    outside.write_text("unrelated private file")
    try:
        attachment.symlink_to(outside)
    except OSError:
        pytest.skip("Creating symbolic links requires privileges on this platform")
    result = web.get(f"/api/evidence/{evidence['id']}", headers=headers)
    assert result.status_code == 400
    assert b"unrelated private file" not in result.data
