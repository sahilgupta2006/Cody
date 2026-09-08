# Cody VS Code Extension (v0.1.0)

Sidebar + commands for the Cody backend in this repo. No build step, no npm dependencies.

## What it gives you

- **Cody sidebar** (compass icon): Hotspots (most-called functions) + Files. Click to jump to code.
- **Command Palette**: `Cody: Analyze Workspace`, `Cody: Open Dependency Map`, `Cody: Search Symbol...`, `Cody: Show Hotspots`.
- **Auto-pilot**: on launch it starts `python main.py <workspace>` if the backend isn't running, then analyzes.

## Run it (2 minutes, noob-proof)

1. Open this repo in VS Code: `File > Open Folder > .../Cody`.
2. Go to **Run and Debug** (`Ctrl+Shift+D`) > **"Run Extension"** > press **F5**.
   - If there's no launch config, instead: open `vscode-extension/extension.js`, press **F5**, choose **"VS Code Extension Development"** when asked.
3. A new window opens. In THAT window: `File > Open Folder` > pick any Python project (or `tests/sample_repo` in this repo).
4. The Cody sidebar appears. Wait for "Cody: ready" in the status bar, then click around.
5. `Ctrl+Shift+P > Cody: Open Dependency Map` for the full graph.

Requirements: Python + `pip install -r requirements.txt` (from repo root). Ollama is optional — search/map work without it; AI explanations need `ollama serve`.

## Settings

- `cody.serverUrl` (default `http://127.0.0.1:5000`)
- `cody.pythonPath` (default auto: `py` on Windows, `python3` elsewhere)
- `cody.autoAnalyze` (default `true`)

## Package it (.vsix to share)

```bash
npm install -g @vscode/vsce
cd vscode-extension
vsce package
# -> cody-explorer-0.1.0.vsix ; install via Extensions > ... > Install from VSIX
```

Publishing to the Marketplace needs a publisher token — that's a v1.1 job. Sharing the `.vsix` file directly works today.
