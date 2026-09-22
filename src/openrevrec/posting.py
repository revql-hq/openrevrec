"""Read-only replacement support for a journal batch already recorded as posted."""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal


def _amount(minor: int) -> str:
    return f"{Decimal(minor) / 100:.2f}"


def _balances(rows: list[dict]) -> dict[tuple, dict]:
    balances: dict[tuple, dict] = defaultdict(lambda: {"net_minor": 0, "roles": set(), "obligation_ids": set()})
    for row in rows:
        dimensions = tuple(sorted(row.get("dimensions", {}).items()))
        key = (row["contract_id"], row["account"], dimensions)
        bucket = balances[key]
        bucket["net_minor"] += int(row["debit_minor"]) - int(row["credit_minor"])
        bucket["roles"].add(row["role"])
        bucket["obligation_ids"].update(row.get("obligation_ids", []))
    return balances


def compare_journals(posted: list[dict], revised: list[dict]) -> list[dict]:
    """Net old and revised balanced journals by contract, GL account and dimensions."""
    old, new = _balances(posted), _balances(revised)
    if sum((item["net_minor"] for item in old.values()), 0) or sum((item["net_minor"] for item in new.values()), 0):
        raise ValueError("Posted and revised journals must each balance before replacement support is prepared.")
    lines = []
    for contract_id, account, dimensions in sorted(old.keys() | new.keys()):
        before = old.get((contract_id, account, dimensions), {"net_minor": 0, "roles": set(), "obligation_ids": set()})
        after = new.get((contract_id, account, dimensions), {"net_minor": 0, "roles": set(), "obligation_ids": set()})
        delta = after["net_minor"] - before["net_minor"]
        if not delta:
            continue
        lines.append({
            "contract_id": contract_id, "account": account, "dimensions": dict(dimensions),
            "roles": sorted(before["roles"] | after["roles"]),
            "obligation_ids": sorted(before["obligation_ids"] | after["obligation_ids"]),
            "posted_net": _amount(before["net_minor"]), "revised_net": _amount(after["net_minor"]),
            "debit": _amount(max(0, delta)), "credit": _amount(max(0, -delta)),
        })
    if sum((Decimal(item["debit"]) - Decimal(item["credit"]) for item in lines), Decimal(0)):
        raise ValueError("Replacement journal does not balance.")
    return lines
