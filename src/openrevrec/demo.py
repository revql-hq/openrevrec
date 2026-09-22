"""Five synthetic, explicitly interpreted contracts for a September 2026 close."""

from .workspace import identifier


def demo_commands():
    def price(amount, label="Contract consideration", kind="fixed", **extra):
        return {"id": identifier("price"), "kind": kind, "label": label, "amount": amount, **extra}

    def obligation(name, ssp, method="exact_days", start="2026-09-01", end="2027-08-31", kind="service", **extra):
        return {"id": identifier("pob"), "name": name, "ssp": ssp, "method": method, "start_date": start, "end_date": end, "kind": kind, **extra}

    customers = [{"id": "cus_northstar", "name": "Northstar Studio", "reference": "NS-001"}, {"id": "cus_evergreen", "name": "Evergreen Systems", "reference": "EV-002"}, {"id": "cus_atlas", "name": "Atlas Research", "reference": "AT-003"}]
    for customer in customers:
        yield "create_customer", customer
    saas = obligation("Platform subscription", "12000.00")
    implementation = obligation("Implementation", "3000.00", "point_in_time", end="2026-09-30", kind="implementation")
    subscription = obligation("Subscription", "12000.00")
    advisory = obligation("Research delivery", "10000.00", "progress", end="2026-11-30")
    consumption = obligation("Processing capacity", "10000.00", "usage", end="2026-12-31", total_units="10000")
    support = obligation("Managed support", "6000.00", end="2027-02-28", kind="support")
    bonus = price("3000.00", "Delivery bonus", "variable", included_amount="1000.00", potential_amount="3000.00", estimated_amount="2000.00", estimation_method="most_likely_amount", rationale="Include only the amount supported by the current completion evidence.")
    contracts = [
        {"id": "con_saas", "name": "Annual platform subscription", "customer_id": "cus_northstar", "start_date": "2026-09-01", "end_date": "2027-08-31", "consideration": [price("12000.00")], "obligations": [saas]},
        {"id": "con_bundle", "name": "Implementation and subscription", "customer_id": "cus_evergreen", "start_date": "2026-09-01", "end_date": "2027-08-31", "consideration": [price("13500.00")], "obligations": [implementation, subscription], "rationale": "The two services are distinct. Allocate the bundled discount using relative SSP."},
        {"id": "con_variable", "name": "Research with delivery bonus", "customer_id": "cus_atlas", "start_date": "2026-09-01", "end_date": "2026-11-30", "consideration": [price("6000.00", "Fixed fee"), bonus], "obligations": [advisory]},
        {"id": "con_usage", "name": "Finite-unit processing package", "customer_id": "cus_evergreen", "start_date": "2026-09-01", "end_date": "2026-12-31", "consideration": [price("10000.00", "Committed processing capacity")], "obligations": [consumption], "rationale": "Fixed committed consideration is satisfied by units delivered; invoicing follows separately."},
        {"id": "con_support", "name": "Support with proposed expansion", "customer_id": "cus_northstar", "start_date": "2026-09-01", "end_date": "2027-02-28", "consideration": [price("6000.00")], "obligations": [support]},
    ]
    for contract in contracts:
        yield "create_contract", contract
    for contract_id, amount, reference in [("con_saas", "12000.00", "NS-1001"), ("con_bundle", "6750.00", "EV-2001"), ("con_variable", "1500.00", "AT-3001"), ("con_usage", "1000.00", "EV-2002"), ("con_support", "1000.00", "NS-1002")]:
        yield "record_billing", {"contract_id": contract_id, "effective_date": "2026-09-01", "amount": amount, "reference": reference}
    yield "record_milestone", {"contract_id": "con_bundle", "obligation_id": implementation["id"], "effective_date": "2026-09-12", "percentage": "100", "rationale": "Implementation accepted by the customer."}
    yield "record_progress", {"contract_id": "con_variable", "obligation_id": advisory["id"], "effective_date": "2026-09-15", "percentage": "30", "rationale": "Three of ten equally weighted deliverables accepted."}
    yield "reassess_variable_consideration", {"contract_id": "con_variable", "component_id": bonus["id"], "effective_date": "2026-09-22", "included_amount": "2000.00", "rationale": "Additional acceptance evidence supports releasing 1,000 of the constraint. Keep the remaining 1,000 excluded."}
    yield "record_usage", {"contract_id": "con_usage", "obligation_id": consumption["id"], "effective_date": "2026-09-25", "quantity": "1500", "reference": "September meter reading"}
    yield "add_note", {"kind": "task", "entity_id": "con_variable", "body": "Review delivery-bonus evidence before the September close.", "due_date": "2026-09-30"}
    yield "add_note", {"kind": "memo", "entity_id": "con_usage", "body": "This example separates satisfaction from billing. 1,500 units of a 10,000-unit commitment have been delivered; only 1,000 has been billed."}


def load_demo(app):
    """Load all example activity in one transaction, using the canonical commands."""
    with app.workspace.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            state = app._project(db)
            if state["customers"] or state["contracts"]:
                raise ValueError("Load examples into an empty workspace. Your existing records were left unchanged.")
            for command, payload in demo_commands():
                app._execute_in(db, command, payload, "main", "synthetic-example")
            scenario = app._execute_in(db, "create_scenario", {"name": "Proposed support expansion"}, "main", "synthetic-example")
            contract = next(c for c in app._project(db)["contracts"] if c["id"] == "con_support")
            consideration = [{**contract["consideration"][0], "amount": "7200.00"}]
            app._execute_in(db, "modify_contract", {"contract_id": "con_support", "effective_date": "2026-09-16", "treatment": "prospective", "consideration": consideration, "rationale": "The remaining support service is distinct. Allocate revised remaining lifetime consideration prospectively from September 16."}, scenario["id"], "synthetic-example")
            state = app._state(db, "main", "2026-09")
            db.commit()
            return {"result": {"contracts": 5, "scenario_id": scenario["id"], "period": "2026-09"}, "state": state}
        finally:
            if db.in_transaction:
                db.rollback()
