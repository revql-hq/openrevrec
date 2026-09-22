import io
import json

from openrevrec.application import Application
from openrevrec.mcp import serve_stdio


def test_stdio_rejects_malformed_input_and_continues_serving(tmp_path, monkeypatch):
    application = Application.create(tmp_path / "MCP.orr")
    incoming = ['["id"]', '{', '{"id":1,"method":"tools/call","params":[]}',
                '{"id":2,"method":"tools/call","params":{"name":"workspace_state","arguments":[]}}',
                '{"id":3,"method":"ping"}']
    output = io.StringIO()
    monkeypatch.setattr("sys.stdin", io.StringIO("\n".join(incoming)))
    monkeypatch.setattr("sys.stdout", output)
    serve_stdio(application)
    responses = [json.loads(line) for line in output.getvalue().splitlines()]
    assert responses[0]["error"]["code"] == -32600
    assert responses[1]["error"]["code"] == -32700
    assert responses[2]["error"]["code"] == -32600
    assert responses[3]["result"]["isError"] is True
    assert responses[4] == {"jsonrpc": "2.0", "id": 3, "result": {}}
