# Frontend UX opportunities

Ranked by how often the flow is likely to occur, steps removed, and risk of an incomplete accounting record. The first three are addressed in this change. The remaining seven are observations only.

| Rank | Screen / flow | Opportunity | Status |
| --- | --- | --- | --- |
| 1 | Home, Contracts, New contract | Start a contract even with no customers, and create/select a customer inside the contract form. Previously the new-contract action opened a separate customer dialog, then stopped. | Fixed |
| 2 | New contract | Make a blank contract the immediate starting point and offer an explicit one-service shortcut to reuse the fixed contract price as SSP and fill missing labels. Previously a starting-point selection and duplicate entries were required before preview. The accountant still has to review the SSP conclusion. | Fixed |
| 3 | New contract, opening position | After creating a contract with a cutover date, open its opening-position form immediately. Previously the user had to find the contract and start a separate required step. | Fixed |
| 4 | Imports | Lead with the import outcome and exceptions; collapse row-by-row and journal detail until requested. The preview currently presents several dense tables before acceptance. | Identified |
| 5 | Reports, source population | Replace format-sensitive, pipe-delimited text areas with editable rows or a file-assisted mapping flow. A misplaced delimiter currently creates avoidable correction work. | Identified |
| 6 | Settings, account mapping | Split the large policy editor into task-focused sections for default roles, profiles, and assignments, while preserving one reviewable policy preview. | Identified |
| 7 | Contract detail, activity | Make the primary action name the selected activity and surface the common billing action directly. The current type selector plus generic “Record” button makes the next action less clear. | Identified |
| 8 | Scenarios | Bring comparison, conflict resolution, and apply prerequisites into one ordered flow. Lifecycle actions are dispersed across the scenario page and dialogs. | Identified |
| 9 | Period close | Summarize blockers and required attestations before presenting the full close detail, with direct links to the records that need work. | Identified |
| 10 | Customer and contract notes | Put open tasks and their completion action near the relevant customer or contract work, so users do not have to move between note entry and status review. | Identified |

These are interface changes, not changes to revenue recognition or command validation. The fixed-price shortcut is opt-in and does not infer SSP for contracts with multiple obligations or variable consideration.
