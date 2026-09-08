// Cody: Codebase Explorer — VS Code extension.
// No build step, no npm dependencies. Runs on the VS Code extension host (Node 18+).
const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');

let serverProc = null;   // child process handle, only if WE started the server
let statusBar = null;
let output = null;
let treeProvider = null;

function cfg() {
  const c = vscode.workspace.getConfiguration('cody');
  const pythonDefault = c.get('pythonPath')
    || (process.platform === 'win32' ? 'py' : 'python3');
  return {
    serverUrl: ((c.get('serverUrl') || 'http://127.0.0.1:5000')).replace(/\/$/, ''),
    python: pythonDefault,
    autoAnalyze: c.get('autoAnalyze') !== false,
  };
}

// ---- tiny HTTP helper (uses global fetch on modern VS Code) ----
async function api(pathSuffix, opts = {}) {
  const { serverUrl } = cfg();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
  try {
    const res = await fetch(serverUrl + pathSuffix, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathSuffix}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function serverUp() {
  try {
    await api('/api/health', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function setStatus(text) {
  if (statusBar) statusBar.text = text;
}

// ---- server lifecycle ----
async function ensureServer() {
  if (await serverUp()) return true;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('Cody: open a folder first, then run "Cody: Analyze Workspace".');
    return false;
  }
  const { python, serverUrl } = cfg();
  let port = '5000';
  try { port = new URL(serverUrl).port || '5000'; } catch { /* keep default */ }
  const backendDir = path.join(__dirname, '..'); // repo root (contains main.py)

  output.appendLine(`[cody] starting backend: ${python} main.py --no-browser --port ${port}`);
  output.show(true);
  const useShell = process.platform === 'win32';
  serverProc = spawn(python,
    ['main.py', folders[0].uri.fsPath, '--no-browser', '--port', String(port)],
    { cwd: backendDir, shell: useShell });
  serverProc.stdout.on('data', (d) => output.append(d.toString()));
  serverProc.stderr.on('data', (d) => output.append(d.toString()));
  serverProc.on('exit', (code) => {
    output.appendLine(`[cody] backend exited (code ${code})`);
    serverProc = null;
  });

  setStatus('$(sync~spin) Cody: starting…');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await serverUp()) {
      setStatus('$(check) Cody: ready');
      return true;
    }
  }
  setStatus('$(error) Cody: offline');
  vscode.window.showErrorMessage(
    'Cody: backend did not start. See Output > Cody. Is Python installed with requirements? (pip install -r requirements.txt)');
  return false;
}

// ---- analyze current workspace ----
async function analyzeWorkspace(silent = false) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    if (!silent) vscode.window.showWarningMessage('Cody: open a folder to analyze.');
    return;
  }
  if (!await ensureServer()) return;
  const folderPath = folders[0].uri.fsPath;
  setStatus('$(sync~spin) Cody: analyzing…');
  let job;
  try {
    job = await api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: folderPath, skip_llm: true }),
    });
  } catch (e) {
    setStatus('$(error) Cody: offline');
    vscode.window.showErrorMessage('Cody: could not start analysis (' + e.message + ')');
    return;
  }
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    let st;
    try {
      st = await api(`/api/analyze/status?job_id=${encodeURIComponent(job.job_id)}`);
    } catch { continue; }
    if (st.status === 'done') {
      setStatus('$(check) Cody: ready');
      treeProvider.refresh();
      if (!silent) vscode.window.showInformationMessage('Cody: workspace indexed. Open the Cody sidebar or dependency map.');
      return;
    }
    if (st.status === 'error') {
      setStatus('$(error) Cody: failed');
      vscode.window.showErrorMessage('Cody: analysis failed — ' + (st.error || st.detail || 'unknown error'));
      return;
    }
    setStatus(`$(sync~spin) Cody: ${st.phase || 'working'}…`);
  }
  setStatus('$(error) Cody: timed out');
  vscode.window.showErrorMessage('Cody: analysis timed out. Try a smaller folder first.');
}

// ---- sidebar tree: Hotspots + Files ----
class SectionItem extends vscode.TreeItem {
  constructor(label, kind) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.kind = kind; // 'hotspots' | 'files'
    this.contextValue = kind;
  }
}

class SymbolItem extends vscode.TreeItem {
  constructor(name, nodeId, filePath, detail) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.nodeId = nodeId;
    this.filePath = filePath;
    this.description = detail;
    this.tooltip = filePath;
    this.iconPath = new vscode.ThemeIcon('symbol-function');
    this.command = { command: 'cody.openSymbol', title: 'Open Symbol', arguments: [this] };
  }
}

class FileItem extends vscode.TreeItem {
  constructor(relPath, filePath, count) {
    super(`${relPath} (${count})`, vscode.TreeItemCollapsibleState.None);
    this.filePath = filePath;
    this.tooltip = filePath;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.command = { command: 'cody.openFile', title: 'Open File', arguments: [this] };
  }
}

class CodyProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() { this._emitter.fire(); }
  getTreeItem(el) { return el; }
  async getChildren(el) {
    if (!await serverUp()) return [new vscode.TreeItem('Cody server offline — run "Cody: Analyze Workspace"')];
    if (!el) return [new SectionItem('Hotspots (most called)', 'hotspots'), new SectionItem('Files', 'files')];
    try {
      if (el.kind === 'hotspots') {
        const d = await api('/api/hotspots');
        return (d.fan_in || []).slice(0, 10)
          .map((h) => new SymbolItem(h.name, h.id, h.filepath, `← ${h.count} callers`));
      }
      if (el.kind === 'files') {
        const d = await api('/api/files');
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        return (d.files || []).slice(0, 200).map((f) => {
          const rel = root && f.filepath.startsWith(root)
            ? path.relative(root, f.filepath) : f.filepath;
          return new FileItem(rel, f.filepath, f.count);
        });
      }
    } catch (e) {
      return [new vscode.TreeItem('Cody: ' + e.message)];
    }
    return [];
  }
}

// ---- open a symbol at its definition line ----
async function openSymbol(item) {
  try {
    const d = await api(`/api/node/details?node_id=${encodeURIComponent(item.nodeId)}`);
    const doc = await vscode.workspace.openTextDocument(d.filepath);
    const ed = await vscode.window.showTextDocument(doc);
    const line = Math.max(0, (d.start_row || 0));
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } catch (e) {
    vscode.window.showErrorMessage('Cody: cannot open symbol (' + e.message + ')');
  }
}

// ---- commands ----
async function searchSymbol() {
  if (!await ensureServer()) return;
  const q = await vscode.window.showInputBox({ prompt: 'Cody: search functions, classes, files' });
  if (!q) return;
  let results;
  try {
    results = (await api(`/api/search?q=${encodeURIComponent(q)}`)).results || [];
  } catch (e) {
    vscode.window.showErrorMessage('Cody: search failed (' + e.message + ')');
    return;
  }
  if (!results.length) {
    vscode.window.showInformationMessage('Cody: no matches for "' + q + '"');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    results.slice(0, 30).map((r) => ({
      label: r.name,
      description: r.type === 'class_definition' ? 'class' : 'function',
      detail: r.filepath,
      node: r,
    })),
    { placeHolder: `${results.length} match(es)` });
  if (!pick) return;
  await openSymbol({ nodeId: pick.node.id });
}

function openMap() {
  const { serverUrl } = cfg();
  const panel = vscode.window.createWebviewPanel(
    'codyMap', 'Cody: Dependency Map',
    vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${serverUrl.replace(/"/g, '')}; style-src 'unsafe-inline';">
<style>html,body{margin:0;padding:0;height:100%;background:#0b0b0f;color:#e2e8f0;font-family:sans-serif}
.bar{padding:8px 12px;font-size:12px;background:#12121a;border-bottom:1px solid #222}
a{color:#818cf8} iframe{width:100%;height:calc(100% - 37px);border:0}</style>
</head><body>
<div class="bar">Cody map: <a href="${serverUrl}/">${serverUrl}/</a> &nbsp;— if empty, run <b>Cody: Analyze Workspace</b> first.</div>
<iframe src="${serverUrl}/"></iframe>
</body></html>`;
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  output = vscode.window.createOutputChannel('Cody');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(compass) Cody';
  statusBar.tooltip = 'Cody: Codebase Explorer';
  statusBar.command = 'cody.openMap';
  statusBar.show();
  context.subscriptions.push(statusBar, output);

  treeProvider = new CodyProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codyExplorer', treeProvider),
    vscode.commands.registerCommand('cody.analyzeWorkspace', () => analyzeWorkspace(false)),
    vscode.commands.registerCommand('cody.openMap', async () => { if (await ensureServer()) openMap(); }),
    vscode.commands.registerCommand('cody.searchSymbol', searchSymbol),
    vscode.commands.registerCommand('cody.showHotspots', () => vscode.commands.executeCommand('workbench.view.extension.cody')),
    vscode.commands.registerCommand('cody.openSymbol', openSymbol),
    vscode.commands.registerCommand('cody.openFile', async (item) => {
      try {
        const doc = await vscode.workspace.openTextDocument(item.filePath);
        await vscode.window.showTextDocument(doc);
      } catch (e) {
        vscode.window.showErrorMessage('Cody: cannot open file (' + e.message + ')');
      }
    }),
  );

  // Fire-and-forget auto analysis so the sidebar is alive on launch.
  if (cfg().autoAnalyze && vscode.workspace.workspaceFolders?.length) {
    setStatus('$(sync~spin) Cody: analyzing…');
    analyzeWorkspace(true).catch((e) => output.appendLine('[cody] auto-analyze failed: ' + e.message));
  }
}

function deactivate() {
  // Only stop the server if this extension started it.
  if (serverProc) {
    try { serverProc.kill(); } catch { /* already gone */ }
    serverProc = null;
  }
}

module.exports = { activate, deactivate };
