"""Portable workspaces and the small, explicit SQLite persistence boundary."""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS workspace_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','archived','applied')),
    base_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_sets (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    scenario_id TEXT NOT NULL REFERENCES scenarios(id),
    command TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    effective_date TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    source TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    idempotency_key TEXT UNIQUE,
    request_hash TEXT,
    originating_change_set_id TEXT REFERENCES change_sets(id)
);
CREATE INDEX IF NOT EXISTS changes_scenario_version ON change_sets(scenario_id, version);
CREATE INDEX IF NOT EXISTS changes_entity ON change_sets(entity_id, effective_date);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL REFERENCES change_sets(id),
    scenario_id TEXT NOT NULL REFERENCES scenarios(id), entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL, effective_date TEXT NOT NULL, recorded_at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE IF NOT EXISTS period_closes (
    id TEXT PRIMARY KEY, period TEXT NOT NULL, change_set_id TEXT NOT NULL REFERENCES change_sets(id),
    frontier INTEGER NOT NULL, policy_version INTEGER NOT NULL,
    ruleset_version TEXT NOT NULL, engine_version TEXT NOT NULL,
    recorded_at TEXT NOT NULL, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
    backup_path TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS customers AS
    SELECT entity_id AS id, json_extract(payload,'$.name') AS name,
           json_extract(payload,'$.email') AS email, scenario_id, version, effective_date, recorded_at
    FROM change_sets WHERE command='create_customer';
CREATE VIEW IF NOT EXISTS contracts AS
    SELECT entity_id AS id, json_extract(payload,'$.name') AS name,
           json_extract(payload,'$.customer_id') AS customer_id,
           json_extract(payload,'$.start_date') AS start_date,
           json_extract(payload,'$.end_date') AS end_date,
           payload AS baseline, scenario_id, version, effective_date, recorded_at
    FROM change_sets WHERE command='create_contract';
CREATE VIEW IF NOT EXISTS performance_obligations AS
    SELECT c.entity_id AS contract_id, c.scenario_id, c.version,
           json_extract(o.value,'$.id') AS id, json_extract(o.value,'$.name') AS name,
           json_extract(o.value,'$.ssp') AS ssp, json_extract(o.value,'$.method') AS method,
           o.value AS terms
    FROM change_sets c, json_each(c.payload,'$.obligations') o WHERE c.command='create_contract';
CREATE VIEW IF NOT EXISTS consideration_components AS
    SELECT c.entity_id AS contract_id, c.scenario_id, c.version,
           json_extract(p.value,'$.id') AS id, json_extract(p.value,'$.kind') AS kind,
           json_extract(p.value,'$.amount') AS amount,
           json_extract(p.value,'$.included_amount') AS included_amount, p.value AS terms
    FROM change_sets c, json_each(c.payload,'$.consideration') p WHERE c.command='create_contract';
CREATE VIEW IF NOT EXISTS accounting_activity AS
    SELECT version, id AS change_set_id, scenario_id, entity_id AS contract_id,
           command AS activity_type, effective_date, recorded_at, source, rationale, payload
    FROM change_sets WHERE command IN ('record_billing','record_progress','record_usage',
       'record_milestone','record_adjustment','modify_contract','reassess_variable_consideration');
CREATE VIEW IF NOT EXISTS accounting_versions AS
    SELECT entity_id, scenario_id, version, command, effective_date AS effective_from,
           lead(effective_date) OVER (PARTITION BY entity_id, scenario_id ORDER BY effective_date,version) AS next_effective_date,
           recorded_at, payload, id AS change_set_id
    FROM change_sets WHERE command IN ('create_contract','modify_contract','reassess_variable_consideration','set_policy');
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def identifier(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def dumps(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


class Workspace:
    """One directory package with an ordinary, inspectable SQLite database."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.db_path = self.path / "workspace.sqlite3"
        if not self.db_path.is_file():
            raise ValueError(f"No OpenRevRec workspace found at {self.path}")
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version != SCHEMA_VERSION:
                raise ValueError(f"Unsupported workspace schema {version}; expected {SCHEMA_VERSION}.")

    @classmethod
    def create(cls, path: str | Path, name: str = "My company", currency: str = "USD"):
        path = Path(path).expanduser().resolve()
        if path.suffix.lower() != ".orr":
            raise ValueError("Workspace names must end in .orr")
        if not name.strip():
            raise ValueError("Company name is required.")
        if currency not in {"USD", "EUR", "GBP", "CAD", "AUD"}:
            raise ValueError("Choose USD, EUR, GBP, CAD, or AUD; this prototype uses two decimal places.")
        if path.exists() and any(path.iterdir()):
            raise ValueError("The workspace directory must be empty.")
        path.mkdir(parents=True, exist_ok=True)
        for subdir in ("attachments", "exports", "backups"):
            (path / subdir).mkdir()
        meta = {"id": identifier("ws"), "name": name.strip(), "currency": currency, "created_at": now(), "schema_version": SCHEMA_VERSION}
        with closing(sqlite3.connect(path / "workspace.sqlite3")) as db, db:
            db.executescript(SCHEMA)
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            db.executemany("INSERT INTO workspace_metadata VALUES (?,?)", [(k, dumps(v)) for k, v in meta.items()])
            db.execute("INSERT INTO scenarios VALUES ('main','Main','active',0,?)", (meta["created_at"],))
            for table in ("change_sets", "events", "period_closes"):
                for action in ("UPDATE", "DELETE"):
                    db.execute(f"CREATE TRIGGER {table}_no_{action.lower()} BEFORE {action} ON {table} BEGIN SELECT RAISE(ABORT,'Accepted accounting history is immutable'); END")
        (path / "workspace.json").write_text(json.dumps(meta, indent=2) + "\n")
        return cls(path)

    @contextmanager
    def connect(self):
        # sqlite3's own context manager commits/rolls back but does not close.
        with closing(sqlite3.connect(self.db_path, timeout=15, isolation_level=None)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA busy_timeout=15000")
            with db:
                yield db

    def metadata(self, db) -> dict:
        return {r["key"]: json.loads(r["value"]) for r in db.execute("SELECT * FROM workspace_metadata")}

    def evidence_path(self, relative: str) -> Path:
        attachment = (self.path / relative).resolve()
        if not attachment.is_relative_to(self.path / "attachments") or not attachment.is_file():
            raise ValueError("Evidence must be stored in this workspace's attachments folder.")
        return attachment

    def backup(self, reason: str) -> Path:
        """Create a consistent SQLite backup plus evidence, configuration, and exports.

        Existing backups are retained beside this snapshot, not recursively copied.
        Call before the first write in an application transaction. A reserved
        writer lock is safe; an outstanding database write would block the copy.
        """
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        destination = self.path / "backups" / f"{stamp}-{reason}.orr"
        destination.mkdir(parents=True)
        with self.connect() as source, closing(sqlite3.connect(destination / "workspace.sqlite3")) as target:
            source.backup(target)
        shutil.copy2(self.path / "workspace.json", destination / "workspace.json")
        for subdir in ("attachments", "exports"):
            shutil.copytree(self.path / subdir, destination / subdir)
        (destination / "backups").mkdir()
        return destination
