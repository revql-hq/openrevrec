"""A small MCP stdio adapter; tools share the public application boundary."""

from __future__ import annotations

import json
import sys

from . import __version__
from .application import COMMANDS

TOOLS = [
    {"name": "workspace_state", "description": "Read accounting state, schedules and journals for a workspace scenario.", "inputSchema": {"type": "object", "properties": {"scenario_id": {"type": "string", "default": "main"}, "period": {"type": "string"}}}, "annotations": {"readOnlyHint": True}},
    {"name": "preview_change", "description": "Calculate a proposed accounting command and financial diff without persisting it.", "inputSchema": {"type": "object", "properties": {"command": {"type": "string", "enum": sorted(COMMANDS)}, "payload": {"type": "object"}, "scenario_id": {"type": "string"}, "period": {"type": "string"}}, "required": ["command", "payload"]}, "annotations": {"readOnlyHint": True}},
    {"name": "record_change", "description": "Execute a canonical accounting command. Prefer proposals in a scenario; applying to Main requires the accountant's acceptance.", "inputSchema": {"type": "object", "properties": {"command": {"type": "string", "enum": sorted(COMMANDS)}, "payload": {"type": "object"}, "scenario_id": {"type": "string"}, "period": {"type": "string"}, "idempotency_key": {"type": "string"}}, "required": ["command", "payload"]}, "annotations": {"readOnlyHint": False, "destructiveHint": False}},
    {"name": "compare_scenario", "description": "Compare a scenario's revenue, balances and journal impact with Main.", "inputSchema": {"type": "object", "properties": {"scenario_id": {"type": "string"}, "period": {"type": "string"}}, "required": ["scenario_id"]}, "annotations": {"readOnlyHint": True}},
    {"name": "query_sql", "description": "Run a read-only SQLite query against the accounting history; capped at 1,000 rows.", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}, "annotations": {"readOnlyHint": True}},
]


def handle(application, request):
    if not isinstance(request, dict):
        raise ValueError("MCP request must be an object.")
    method, params = request.get("method"), request.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("MCP params must be an object.")
    if method == "initialize":
        return {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}, "serverInfo": {"name": "openrevrec", "version": __version__}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name, arguments = params.get("name"), params.get("arguments", {})
        functions = {"workspace_state": application.state, "preview_change": application.preview, "record_change": application.execute, "compare_scenario": application.compare, "query_sql": application.query}
        try:
            if name not in functions:
                raise ValueError("Unknown tool.")
            if not isinstance(arguments, dict):
                raise ValueError("Tool arguments must be an object.")
            result = functions[name](**arguments)
            return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": False}
        except (ValueError, TypeError) as exc:
            return {"content": [{"type": "text", "text": str(exc)}], "isError": True}
    raise ValueError(f"Unsupported MCP method: {method}")


def serve_stdio(application):
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("MCP request must be an object.")
            if "id" not in request:
                continue
            response = {"jsonrpc": "2.0", "id": request["id"], "result": handle(application, request)}
        except json.JSONDecodeError as exc:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}}
        except (ValueError, TypeError) as exc:
            response = {"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else None, "error": {"code": -32600, "message": str(exc)}}
        print(json.dumps(response), flush=True)
