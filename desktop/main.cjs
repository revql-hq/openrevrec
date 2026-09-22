const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
if (process.env.ORR_USER_DATA) app.setPath('userData', path.resolve(process.env.ORR_USER_DATA));
const developmentUrl = !app.isPackaged && process.env.ORR_DEV_URL;
let mainWindow;
let server;
let serverOrigin;
let serverToken;
let workspacePath;
let quitting = false;
let switching = false;

function metadata() {
  let name = path.basename(workspacePath || '', '.orr');
  try { name = JSON.parse(fs.readFileSync(path.join(workspacePath, 'workspace.json'), 'utf8')).name || name; } catch { /* Defaults cover new workspaces. */ }
  return { path: workspacePath, name, needsSetup: workspacePath === bootstrapPath() };
}

function settingsPath() { return path.join(app.getPath('userData'), 'workspace.json'); }
function bootstrapPath() { return path.join(app.getPath('userData'), 'Setup.orr'); }
function appIconPath() { return app.isPackaged ? path.join(process.resourcesPath, 'app-icon.png') : path.join(root, 'assets', 'icon.png'); }
function backendRuntime() {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'openrevrec-server.exe' : 'openrevrec-server')
    : path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(executable)) throw new Error('OpenRevRec could not find its Python runtime. In a source checkout, run npm run setup.');
  return { executable, args: app.isPackaged ? [] : ['-m', 'openrevrec'] };
}

function initialWorkspace() {
  if (process.env.ORR_WORKSPACE) return path.resolve(process.env.ORR_WORKSPACE);
  try {
    const recent = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).path;
    if (recent && fs.existsSync(path.join(recent, 'workspace.sqlite3'))) return recent;
  } catch { /* First launch has no recent workspace. */ }
  return bootstrapPath();
}

function rememberWorkspace() {
  if (workspacePath === bootstrapPath()) return;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ path: workspacePath }, null, 2));
}

async function stopServer() {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolveStop(); });
    child.kill('SIGTERM');
  });
}

async function startServer(selectedPath) {
  const { executable, args } = backendRuntime();
  const token = randomBytes(32).toString('hex');
  args.push('serve', '--workspace', selectedPath, '--port', developmentUrl ? '4318' : '0', '--token', token);
  if (!developmentUrl) args.push('--static-dir', app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(root, 'frontend/dist'));
  const child = spawn(executable, args, { cwd: app.isPackaged ? app.getPath('userData') : root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server = child;
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-6000); process.stderr.write(chunk); });
  const ready = await new Promise((resolveReady, reject) => {
    let settled = false;
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error(`The accounting engine did not start within 30 seconds.\n${diagnostics}`)), 30000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      error ? reject(error) : resolveReady(value);
    }
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line);
        if (Number.isInteger(value.port) && value.port > 0) finish(null, value);
      } catch { /* A dependency may print a startup line. */ }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      finish(new Error(`The accounting engine exited (${code}).\n${diagnostics}`));
      if (server === child && !quitting && !switching) {
        dialog.showErrorBox('Accounting engine stopped', diagnostics || 'Restart OpenRevRec to reopen your workspace.');
        app.quit();
      }
    });
  });
  serverOrigin = `http://127.0.0.1:${ready.port}`;
  serverToken = ready.token || token;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverOrigin}/api/health`, { headers: { Authorization: `Bearer ${serverToken}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { workspacePath = selectedPath; return; }
    } catch { /* The socket becomes available just after the readiness message. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('The accounting engine started but did not pass its health check.');
}

async function initializeWorkspace(selectedPath, setup) {
  const name = typeof setup?.name === 'string' ? setup.name.trim() : '';
  const currency = setup?.currency;
  const openingPeriod = setup?.openingPeriod;
  const accounts = setup?.accounts;
  if (!name || !['USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(currency) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(openingPeriod || '') ||
      !accounts || ['revenue', 'deferred_revenue', 'contract_asset', 'billing_clearing'].some((role) => typeof accounts[role] !== 'string' || !accounts[role].trim())) {
    throw new Error('Enter a company name, supported currency, account effective month, and all four default account codes.');
  }
  const { executable, args } = backendRuntime();
  args.push('init', selectedPath, '--name', name, '--currency', currency, '--account-effective-period', openingPeriod, '--accounts-json', JSON.stringify(accounts));
  await new Promise((resolveInit, reject) => {
    const child = spawn(executable, args, { cwd: app.isPackaged ? app.getPath('userData') : root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let diagnostics = '';
    child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-6000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveInit() : reject(new Error(diagnostics || 'Workspace initialization failed.')));
  });
}

async function loadWorkspace(selectedPath) {
  if (switching) return null;
  switching = true;
  const previous = workspacePath;
  try {
    await stopServer();
    await startServer(selectedPath);
    rememberWorkspace();
    if (mainWindow) { await mainWindow.loadURL(developmentUrl || serverOrigin); mainWindow.setTitle(`${metadata().name} — OpenRevRec`); }
    return metadata();
  } catch (error) {
    await stopServer();
    if (previous) {
      try { await startServer(previous); rememberWorkspace(); await mainWindow?.loadURL(developmentUrl || serverOrigin); }
      catch { app.quit(); }
    }
    throw error;
  } finally { switching = false; }
}

async function chooseWorkspace(create, setup) {
  const parent = path.join(app.getPath('documents'), 'OpenRevRec');
  fs.mkdirSync(parent, { recursive: true });
  if (create) {
    if (!setup) throw new Error('Complete the workspace setup form before creating a workspace.');
    const suggested = String(setup.name || 'Untitled').replace(/[^a-z0-9 -]/gi, '').trim().replace(/\s+/g, '-') || 'Untitled';
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Create workspace', buttonLabel: 'Create workspace', defaultPath: path.join(parent, suggested + '.orr'), filters: [{ name: 'OpenRevRec workspace', extensions: ['orr'] }] });
    if (result.canceled || !result.filePath) return null;
    const selected = result.filePath.toLowerCase().endsWith('.orr') ? result.filePath : `${result.filePath}.orr`;
    if (fs.existsSync(selected)) throw new Error('That location already exists. Use Open workspace to open an existing .orr folder.');
    await initializeWorkspace(selected, setup);
    return loadWorkspace(selected);
  }
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Open workspace', buttonLabel: 'Open workspace', defaultPath: parent, properties: ['openDirectory', 'treatPackageAsDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = result.filePaths[0];
  if (!fs.existsSync(path.join(selected, 'workspace.sqlite3'))) throw new Error('Choose an .orr workspace folder containing workspace.sqlite3.');
  return loadWorkspace(selected);
}

async function guardedPicker(create, setup) {
  try { return await chooseWorkspace(create, setup); }
  catch (error) { await dialog.showMessageBox(mainWindow, { type: 'error', message: 'Unable to open workspace', detail: error.message }); return null; }
}

function setupMenu() {
  const file = { label: 'File', submenu: [
    { label: 'New workspace…', accelerator: 'CmdOrCtrl+Shift+N', click: () => mainWindow?.webContents.send('workspace:request-create') },
    { label: 'Open workspace…', accelerator: 'CmdOrCtrl+O', click: () => guardedPicker(false) },
    { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' },
  ] };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), file,
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

function validateSender(event) {
  const origin = new URL(event.senderFrame.url).origin;
  if (![serverOrigin, developmentUrl].includes(origin)) throw new Error('Unrecognized workspace window.');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    setupMenu();
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const url = new URL(details.url);
      if (url.origin === serverOrigin || (developmentUrl && url.origin === developmentUrl && url.pathname.startsWith('/api/'))) details.requestHeaders.Authorization = `Bearer ${serverToken}`;
      callback({ requestHeaders: details.requestHeaders });
    });
    ipcMain.handle('workspace:get', (event) => { validateSender(event); return metadata(); });
    ipcMain.handle('workspace:open', (event) => { validateSender(event); return guardedPicker(false); });
    ipcMain.handle('workspace:create', (event, setup) => { validateSender(event); return guardedPicker(true, setup); });
    await loadWorkspace(initialWorkspace());
    mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 680, backgroundColor: '#f9f9f8', title: `${metadata().name} — OpenRevRec`, icon: appIconPath(), show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== (developmentUrl || serverOrigin)) event.preventDefault(); });
    mainWindow.webContents.on('page-title-updated', (event) => { event.preventDefault(); mainWindow.setTitle(`${metadata().name} — OpenRevRec`); });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    await mainWindow.loadURL(developmentUrl || serverOrigin);
    mainWindow.setTitle(`${metadata().name} — OpenRevRec`);
    if (process.env.ORR_SMOKE_TEST === '1') {
      async function request(route, options = {}) {
        const headers = { Authorization: `Bearer ${serverToken}` };
        if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
        const response = await fetch(`${serverOrigin}${route}`, { ...options, headers });
        if (!response.ok) throw new Error(`Desktop smoke ${route} failed: ${response.status}`);
        return response;
      }
      let state = await (await request('/api/state?period=2026-09')).json();
      if (process.env.ORR_SMOKE_REOPEN !== '1') {
        if (state.contracts.length === 0) await request('/api/demo', { method: 'POST', body: '{}' });
        state = await (await request('/api/state?period=2026-09')).json();
        const reports = await (await request('/api/reports?period=2026-09')).json();
        if (!reports.checks.length || !reports.rollforward.length) throw new Error('Desktop smoke reports are empty.');
        if (!state.report.closed) {
          const unsupported = reports.exceptions.evidence;
          if (!unsupported.length) throw new Error('Desktop smoke has no judgment exception to resolve.');
          for (const judgment of unsupported) {
            const detail = await (await request(`/api/changes/${judgment.change_set_id}?period=2026-09`)).json();
            if (detail.change.id !== judgment.change_set_id) throw new Error('Desktop smoke change detail did not match its exception.');
            const support = new FormData();
            support.append('file', new Blob([`Reviewed ${judgment.change_set_id}`], { type: 'text/plain' }), 'desktop-smoke-support.txt');
            support.append('target_change_set_id', judgment.change_set_id);
            if (judgment.entity_id) support.append('entity_id', judgment.entity_id);
            support.append('rationale', 'Desktop close support smoke');
            await request('/api/evidence', { method: 'POST', body: support });
            await request('/api/commands', { method: 'POST', body: JSON.stringify({
              command: 'record_judgment_review',
              period: '2026-09',
              payload: {
                target_change_set_id: judgment.change_set_id,
                reviewer: 'Desktop smoke',
                disposition: 'supported',
                conclusion: `Reviewed the accounting judgment for ${judgment.change_set_id}.`,
                support_memo: 'Reviewed the attached desktop smoke support file.'
              }
            }) });
          }
          const supported = await (await request('/api/reports?period=2026-09')).json();
          if (supported.exceptions.evidence.length || supported.checks.find((check) => check.id === 'evidence')?.status !== 'pass') throw new Error('Desktop smoke judgment review did not clear the close exception.');
          const dispositions = Object.fromEntries(supported.checks.filter((check) => check.status === 'review').map((check) => [check.id, { disposition: 'accepted', reason: 'Desktop smoke reviewed ' + check.label }]));
          const preview = await (await request('/api/preview', { method: 'POST', body: JSON.stringify({ command: 'close_period', payload: { period: '2026-09', rationale: 'Desktop smoke preview', review_dispositions: dispositions }, period: '2026-09' }) })).json();
          if (!preview.state.report.closed) throw new Error('Desktop smoke close preview did not produce a checkpoint.');
          const close = await (await request('/api/commands', { method: 'POST', body: JSON.stringify({ command: 'close_period', payload: { period: '2026-09', rationale: 'Desktop smoke reviewed support', review_dispositions: dispositions }, period: '2026-09' }) })).json();
          if (!close.state.report.closed) throw new Error('Desktop smoke did not close the period.');
        }
        const workbook = Buffer.from(await (await request('/api/export?period=2026-09')).arrayBuffer());
        if (workbook.toString('utf8', 0, 2) !== 'PK') throw new Error('Desktop smoke Excel export is invalid.');
        const navigated = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
          const reports = [...document.querySelectorAll('.nav-item')].find((item) => item.textContent.trim() === 'Reports');
          if (!reports) return resolve(false);
          reports.click();
          let attempts = 0;
          const timer = setInterval(() => {
            if (document.querySelector('h1')?.textContent === 'Reports' && document.querySelector('.report-tabs')) { clearInterval(timer); resolve(true); }
            else if (++attempts > 100) { clearInterval(timer); resolve(false); }
          }, 50);
        })`);
        if (!navigated) throw new Error('Desktop smoke could not navigate to Reports.');
        const previous = workspacePath;
        try { await loadWorkspace(path.join(previous, 'workspace.json', 'invalid.orr')); throw new Error('Invalid workspace switch unexpectedly succeeded.'); }
        catch (error) { if (error.message.includes('unexpectedly succeeded')) throw error; }
        if (workspacePath !== previous) throw new Error('Desktop smoke workspace recovery changed the active path.');
        await request('/api/health');
      }
      if (state.contracts.length !== 5) throw new Error('Desktop smoke demo workspace was not retained.');
      if (!state.report.closed) {
        state = await (await request('/api/state?period=2026-09')).json();
        if (!state.report.closed) throw new Error('Desktop smoke close was not retained.');
      }
      const smokeResult = { desktop_smoke: 'ok', workspace: metadata(), title: mainWindow.getTitle(), contracts: state.contracts.length, reopened: process.env.ORR_SMOKE_REOPEN === '1' };
      if (process.env.ORR_SMOKE_RESULT) fs.writeFileSync(path.resolve(process.env.ORR_SMOKE_RESULT), JSON.stringify(smokeResult));
      console.log(JSON.stringify(smokeResult));
      app.quit();
    }
  }).catch(async (error) => {
    console.error(error);
    if (process.env.ORR_SMOKE_RESULT) fs.writeFileSync(path.resolve(process.env.ORR_SMOKE_RESULT), JSON.stringify({ desktop_smoke: 'failed', error: error.message }));
    if (process.env.ORR_SMOKE_TEST !== '1') dialog.showErrorBox('OpenRevRec could not start', error.message);
    await stopServer();
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopServer().finally(() => app.quit());
  });
}
