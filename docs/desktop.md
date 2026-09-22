# Desktop development and packaging

The Electron shell runs a local Python accounting engine and displays the React application. Packaged applications include a PyInstaller one-directory backend bundle and the built interface. Python is not an end-user prerequisite.

## Development

```sh
npm ci
npm run setup
npm run desktop
```

The desktop development command starts Vite on port 5173. Electron starts the accounting engine on port 4318 and attaches its API token to requests. Frontend edits update through Vite; restart the command after changing Python or desktop-shell code.

For a specific workspace on macOS:

```sh
ORR_WORKSPACE="$PWD/.local/Testing.orr" npm run desktop
```

In PowerShell:

```powershell
$env:ORR_WORKSPACE = "$PWD\.local\Testing.orr"
npm run desktop
```

## Build on macOS

```sh
npm run package:mac
```

This builds the frontend, freezes the Python engine, and produces a ZIP containing `OpenRevRec.app` in `release/`. The app uses a free local port, keeps Python inside its bundle, and starts independently of the repository or current working directory. The build architecture follows the host Mac. To produce an unpacked app for testing, use `npm run package:dir`.

The local build is unsigned and not notarized. Signing credentials and notarization are not configured in the repository.

## Build on Windows

Use a Windows machine with Node.js and uv installed:

```powershell
npm ci
npm run setup
npm run package:windows
```

The output in `release/` includes:

- `OpenRevRec-0.1.0-x64-setup.exe`: an NSIS installer with a user-selected installation directory.
- `OpenRevRec-0.1.0-x64-portable.exe`: the portable desktop executable.

Workspace files live outside the installed application. The portable executable still stores its preferences in Windows application data and uses a normal `.orr` workspace folder. It is not a fully self-contained USB workspace.

PyInstaller builds for the operating system on which it runs. A macOS Python bundle cannot be put into a working Windows installer. The [PyInstaller usage documentation](https://www.pyinstaller.org/en/stable/usage.html) describes this platform requirement.

## CI artifacts

The `Test and package desktop` GitHub Actions workflow runs on Windows and macOS. It installs locked dependencies, runs the accounting and workspace tests, builds the frontend, freezes the backend, runs the backend smoke test, and creates desktop packages. The Windows job then silently installs NSIS, runs the installed and portable executables against a workspace path containing spaces, reopens each to check preferences, checks recovery after a failed workspace switch, and uninstalls while retaining the workspace. SHA-256 sums are uploaded with the packages. The workflow does not publish a release or configure automatic updates.

The unattended Windows check is configured in `scripts/smoke_windows.ps1`. A successful Windows job is needed before treating native Windows operation as verified; a local Mac build cannot provide that proof. Inspect the installer, executable, taskbar, and installed-app icon in the Windows shell as a separate visual check.

## Runtime checks

```sh
npm run build
npm run build:backend
npm run smoke:backend
```

The smoke script launches the frozen backend from a temporary directory whose name contains spaces. It verifies authentication, example contracts, Excel export, template delivery, and static UI delivery. This catches missing bundled dependencies and paths that work only from the source checkout.

The desktop shell also accepts `ORR_SMOKE_TEST=1`, which opens the real application, loads the demo, inspects each unsupported judgment, attaches support, confirms the exception clears, closes the period, navigates to Reports, exports the closed workbook, tests recovery after a failed workspace switch, prints a result, and quits. Set `ORR_WORKSPACE` to a disposable directory and `ORR_USER_DATA` to a separate preferences directory for this check. Run again with `ORR_SMOKE_REOPEN=1` and without `ORR_WORKSPACE` to verify that preferences reopen the closed workspace. The Windows script performs both runs for the installed app and the portable executable.

Electron uses a sandboxed renderer, context isolation, and a narrow preload bridge for native workspace dialogs. See [Electron's context-isolation documentation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) for the underlying mechanism.
