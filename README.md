# OpenRevRec

A local revenue accounting workbench. Keep contracts, accounting activity, scenarios, schedules, journals, and period closes in a portable `.orr` workspace.

OpenRevRec runs on your computer. It does not require a cloud account, AI service, or RevQL subscription.

## Run locally

Install [Node.js 22.12 or later](https://nodejs.org/) and [uv](https://docs.astral.sh/uv/getting-started/installation/). Then, from this repository:

```sh
npm ci
npm run setup
npm run desktop
```

The setup command creates a local Python 3.12 environment. The desktop application starts its accounting engine automatically and opens a workspace in `Documents/OpenRevRec/My company.orr`. Use **File → New workspace** or **File → Open workspace** to choose another one. The last workspace reopens on the next launch.

For browser development:

```sh
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173). The browser development workspace lives at `.local/Development.orr`. Set `ORR_WORKSPACE` to use a different directory. Both development modes use ports 5173 and 4318; run one mode at a time. Press Ctrl+C in the terminal to stop the application and its engine.

## Try a close

Start with an empty workspace and load the example contracts from the workbench. The examples cover prepaid subscription revenue, multiple obligations, variable consideration, usage, and a modification.

1. Choose September 2026 and inspect the effective account mapping in Settings.
2. Review each contract's consideration, obligations, allocation, billing, and revenue schedule.
3. Record activity or create a scenario to try a different accounting conclusion.
4. Open Reports to review close readiness, the contract balance rollforward, billing timing, recognition coverage, and active scenario impacts. Use **Open** on a check to reach the underlying record.
5. Open an unsupported judgment, inspect its recorded rationale and financial effect, and attach the supporting file to that exact change. Review the journal, close the period, and export the support workbook.

You can also create customers and contracts manually. Descriptive edits are kept separate from dated accounting changes. Supporting files can be attached to a contract or a specific judgment change. Changes go through the same application commands whether entered in the desktop application, API, Python, or an Excel import.

## Workspace and interfaces

A `.orr` workspace is a directory containing a normal SQLite database, metadata, and supporting folders. Copy the entire folder while OpenRevRec is closed to move it to another computer. Period close also creates a backup. See [working with workspaces](docs/workspaces.md).

The current engine supports relative SSP allocation; exact-day, monthly, point-in-time, progress, usage, and milestone recognition; constrained variable consideration; explicit adjustments; prospective and cumulative catch-up changes; effective-dated journal account mappings; isolated scenarios; and closed-period checkpoints. Accounting judgments and rationale remain explicit inputs.

The [accounting guide](docs/accounting.md) explains calculation conventions and prebuilt review views. The [API guide](docs/api.md) covers commands, reports, previews, Excel interchange, and read-only SQL. The [desktop build guide](docs/desktop.md) covers native macOS and Windows packages.

## Validate and package

```sh
npm test
npm run build
npm run build:backend
npm run smoke:backend
npm run package:dir
```

`npm test` runs the accounting, real-workspace, HTTP/MCP, and frontend contract-term tests. The frontend build also checks for unused TypeScript declarations. The frozen-backend smoke test checks that the packaged Python engine starts outside the repository, enforces its API token, loads the examples, exports Excel, and serves the built interface.

The GitHub Actions workflow builds Windows NSIS installers and portable executables, and a macOS app ZIP. Its Windows job is configured to install and smoke-test both executables and verify workspace persistence on uninstall. Packages include Python; end users do not install it. Build each package on its target operating system. Local packages are unsigned.

## Current limits

This is a working prototype for one person and one company currency per workspace. It is not a general ledger, billing system, consolidation system, or automatic accounting-policy evaluator. Review the accounting conclusions and resulting journals before using them in a close. The prototype does not include cloud synchronization, AI assistance, production migration guarantees, or signed installers.

Public documentation describes the available software. Product planning and internal design documents are maintained outside this repository.

## License

OpenRevRec is available under the [MIT License](LICENSE).
