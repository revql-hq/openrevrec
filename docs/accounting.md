# Accounting behavior

These are the calculation conventions in the current prototype. Commercial facts and accounting conclusions are separate inputs: billing does not establish satisfaction, usage does not automatically change an estimate of consideration, and the software does not choose a modification treatment for you.

## Amounts and allocation

Enter money as decimal strings. The engine uses decimal arithmetic, rounds to cents, and allocates transaction price using relative standalone selling prices. Rounding residuals use the largest remainder, with stable obligation IDs breaking ties, so the allocated cents reconcile exactly to the transaction price.

Fixed consideration uses its stated amount. A constrained variable component uses `included_amount`; credit components use negative amounts. The transaction price is the amount included in the accounting conclusion, not the maximum possible commercial amount.

## Satisfaction methods

Start and end dates are inclusive.

| Method | Calculation |
| --- | --- |
| Exact days | Allocated consideration across actual calendar days in the service term. |
| Monthly | Equal weight to every calendar month touched by the service term. Partial first and last months each count as one month; changes inside a month use the elapsed share of that month's service interval. |
| Point in time | Recognize on the recorded satisfaction milestone. |
| Progress | A recorded cumulative percentage establishes satisfaction through that effective date. |
| Usage | Incremental recorded quantities establish satisfaction against the obligation's total units. |
| Milestone | Recorded cumulative percentages establish satisfaction; a completion milestone defaults to 100%. |

Usage, progress, and milestone obligations do not invent future activity. Until that activity is recorded, the report can show remaining consideration with no assumed future recognition date.

A material right is represented as a distinct obligation with allocated consideration. A point-in-time material right recognizes on expiry (`exercise_end`, or `end_date` when absent), or on a satisfaction milestone representing delivery of the promised goods or services. Merely electing an option does not establish that the promised goods or services were transferred.

## Changes and estimates

Contract baselines are retained. Record revised accounting through dated activity with a rationale.

- **Prospective modification:** Revised consideration is the total lifetime amount, including revenue already recognized. The engine preserves recognition through the day before the change and allocates the remainder across the remaining obligation SSP and satisfaction.
- **Cumulative catch-up:** Revised terms establish the amount that should have been recognized by the effective date. The difference from the previous cumulative amount is recorded on that date.
- **Variable consideration reassessment:** The new included amount changes the transaction price and produces the cumulative adjustment required on its effective date.
- **Adjustment:** A signed revenue adjustment is recognized on its effective date. The remaining amount is spread over remaining satisfaction. An adjustment after full satisfaction can leave a residual that the report flags for review.

A separate-contract conclusion is entered as a new contract. For a termination or other amendment, record the revised consideration and obligations explicitly and review the resulting scenario before accepting it.

## Period review views

Reports are calculated from the same accepted state as schedules and journals. Close readiness checks journal balance, allocation, calculation warnings, tasks due by period end, entries recorded after period end, open scenarios, recognition coverage, and evidence for recorded judgment changes. Each check has an **Open** action leading to its underlying record. The close dialog reads the same readiness result.

Modifications, variable-consideration reassessments, manual adjustments, policy changes, and reopen actions require evidence linked to their exact change set for the support check to pass. Contract-level files remain visible but do not count as support for an individual judgment. Activity and contract history open a change detail showing the recorded rationale, treatment, before and after reports, financial effect, and linked files.

The contract balance rollforward derives each opening net position from cumulative recognized revenue and billings before the selected month. Period revenue and billings move that position to the closing contract asset or deferred revenue. Billing versus revenue presents the same timing difference by contract.

Recognition coverage compares remaining revenue after the selected period with revenue already scheduled in future periods. An unscheduled amount is a review item, not an automatic error: progress, usage, milestone, and point-in-time obligations often require additional satisfaction activity before a future amount can be scheduled. Scenario impact shows active proposals against Main, including affected recognition periods and whether Main has advanced beyond a scenario's base version.

## Balances and journals

Revenue and billing are measured separately. The monthly net contract position determines the contract asset or deferred revenue balance. Journals use the revenue, deferred revenue, contract asset, and billing-clearing mapping effective for each month and balance by contract. A later mapping does not rewrite an earlier month's journal. Workspace currency and rounding remain fixed.

The output is journal support for your ledger. OpenRevRec does not maintain cash, collections, receivables aging, taxes, foreign exchange, or a general ledger.

## Closed periods

A close preserves a calculation checkpoint and journal. Accounting changes that would alter a closed result must not be silently accepted. Reopen explicitly, with a rationale, when a prior period needs to change. Review warnings and the journal before closing; a calculation result is not a substitute for the accounting conclusion that produced it.

Protection includes revenue by obligation in the closed month, even when a reallocation leaves the contract total unchanged. New contracts whose contract start, obligation starts, and activity all fall after a closed period can be added without reopening it. Backdated billing or recognition remains protected. The accepted checkpoint continues to supply closed-period balances, schedules, journals, and catch-up support.
