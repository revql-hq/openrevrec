# Working with workspaces

An OpenRevRec workspace ends in `.orr` and is a directory, not a compressed archive. Its contents include:

```text
My company.orr/
  workspace.json
  workspace.sqlite3
  attachments/
  backups/
  exports/
```

The SQLite database contains authoritative accounting state and history. Calculated reports are derived from the selected scenario, activity, policy, and reporting period.

## Create and open

In the desktop application, choose **File → New workspace** or **File → Open workspace**. The shortcuts are Cmd/Ctrl+Shift+N and Cmd/Ctrl+O. Opening another workspace stops the previous workspace's local accounting engine before starting the next one.

From a terminal in a source checkout:

```sh
uv run openrevrec init ./Example.orr --name "Example company"
uv run openrevrec serve --workspace ./Example.orr --port 4318
```

`serve` creates a workspace if the selected path does not exist. Workspace paths must end in `.orr`. Browser development uses `.local/Development.orr` by default; the desktop stores its last chosen workspace in the operating system's application-data directory. The prototype supports USD, EUR, GBP, CAD, and AUD, with two decimal places and one currency per workspace.

## Scenarios and accepted changes

Main holds accepted accounting state. Create a scenario to explore an alternative without changing Main. The comparison shows the financial difference before you apply it. Applying, rebasing, archiving, and restoring are explicit commands retained in the workspace history.

If Main has changed since a scenario was created, rebase and review its comparison before applying. An archived scenario remains in the workspace.

## Period close

Close a period after reviewing the accounting activity, reports, warnings, and journal. A close saves a checkpoint and creates a database backup. Later changes must not silently change a closed period. Reopening a period requires an explicit action and rationale.

## Copy and back up

Quit OpenRevRec before copying an entire `.orr` folder. SQLite may use a write-ahead log while the workspace is open; copying only `workspace.sqlite3` during that time may omit recent changes. Keep the database and supporting files together.

Keep a separate backup before trying the prototype with valuable data. Do not open the same workspace concurrently from multiple desktop instances or run it directly from a shared network drive.

## Inspect SQL

The application provides read-only SQL inspection. You can also inspect a closed workspace with a SQLite tool. Use canonical application commands to record changes; direct database writes bypass accounting validation, immutable history, and close protections.
