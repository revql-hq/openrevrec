"""Command line and local-service entry points."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .application import Application
from .workspace import Workspace


def parser():
    root = argparse.ArgumentParser(prog="openrevrec", description="Local revenue-accounting workspaces")
    sub = root.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init", help="Create an empty .orr workspace")
    init.add_argument("path")
    init.add_argument("--name", default="My company")
    init.add_argument("--currency", default="USD")
    for action in ("serve", "state", "command", "preview", "demo", "export", "import", "sql", "mcp"):
        p = sub.add_parser(action)
        p.add_argument("--workspace", required=True)
        if action in {"state", "command", "preview", "export", "import"}:
            p.add_argument("--scenario", default="main")
            p.add_argument("--period")
        if action == "serve":
            p.add_argument("--port", type=int, default=4318)
            p.add_argument("--token")
            p.add_argument("--static-dir")
        if action in {"command", "preview"}:
            p.add_argument("command")
            p.add_argument("--payload", default="{}", help="JSON object, or @path to a JSON file")
            p.add_argument("--idempotency-key")
        if action == "export":
            p.add_argument("--output", required=True)
        if action == "import":
            p.add_argument("file")
        if action == "sql":
            p.add_argument("query")
    template = sub.add_parser("template")
    template.add_argument("--output", required=True)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.action == "init":
            workspace = Workspace.create(args.path, args.name, args.currency)
            print(json.dumps({"path": str(workspace.path)}))
            return 0
        if args.action == "template":
            from .interchange import template_bytes
            Path(args.output).write_bytes(template_bytes())
            print(json.dumps({"path": str(Path(args.output).resolve())}))
            return 0
        if args.action == "serve" and not (Path(args.workspace).expanduser() / "workspace.sqlite3").is_file():
            Workspace.create(args.workspace, Path(args.workspace).stem)
        application = Application(args.workspace)
        if args.action == "serve":
            from waitress import create_server
            from .api import create_app
            server = create_server(create_app(application, args.token, args.static_dir), host="127.0.0.1", port=args.port, threads=4)
            print(json.dumps({"port": int(server.effective_port), "token": args.token}), flush=True)
            server.run()
            return 0
        if args.action == "state":
            result = application.state(args.scenario, args.period)
        elif args.action in {"command", "preview"}:
            payload_text = Path(args.payload[1:]).read_text() if args.payload.startswith("@") else args.payload
            payload = json.loads(payload_text)
            function = application.execute if args.action == "command" else application.preview
            result = function(args.command, payload, scenario_id=args.scenario, period=args.period, idempotency_key=args.idempotency_key, source="cli")
        elif args.action == "demo":
            from .demo import load_demo
            result = load_demo(application)
        elif args.action == "export":
            from .interchange import export_bytes
            bundle = application.report_bundle(args.scenario, args.period)
            Path(args.output).write_bytes(export_bytes(bundle["state"], bundle["review"]))
            result = {"path": str(Path(args.output).resolve())}
        elif args.action == "import":
            from .interchange import import_bytes
            result = import_bytes(application, Path(args.file).read_bytes(), Path(args.file).name, args.scenario, args.period)
        elif args.action == "sql":
            result = application.query(args.query)
        elif args.action == "mcp":
            from .mcp import serve_stdio
            serve_stdio(application)
            return 0
        print(json.dumps(result, indent=2))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
