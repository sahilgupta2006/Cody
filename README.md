# Cody: Codebase Explorer 🧭

Cody is a human-first tool that analyzes any local or GitHub repository to build an interactive dependency graph of functions, classes, and method call paths. It sniffs dynamic dispatches (callbacks, thread targets) using local LLMs and guides developers through a visual, node-by-node walkthrough.

No complex MCP setups, no commercial editors, no cloud telemetry. Just paste and understand.

---

## Repository Structure

The project is structured as a modular Python package with a Flask web client:

```
Cody/
├── cody/
│   ├── __init__.py
│   ├── parser.py       # Tree-sitter AST parsing & local import resolution
│   ├── database.py     # SQLite database migrations and queries
│   ├── analyzer.py     # Two-pass codebase analysis and Ollama integrations
│   ├── app.py          # Flask HTTP APIs and template rendering
│   ├── templates/
│   │   └── index.html  # Main UI dashboard structure
│   └── static/
│       ├── css/
│       │   └── style.css # Premium dark theme layout system
│       └── js/
│           └── app.js    # Interactive Vis.js graph orchestration
├── main.py             # Server bootstrapper & browser launcher
├── requirements.txt    # Project dependencies
└── README.md           # Documentation
```

---

## Features

- **Interactive Force Directed Graph**: Renders the function/class call relationships using a live, zooming canvas built on `Vis.js`.
- **Dynamic Walkthrough Stepper**: Steps through the codebase using BFS. Highlights the active node (with gold glowing nodes) and updates panels dynamically.
- **Click to Jump**: Clicking any node on the graph instantly shifts the focus, changes the BFS starting point, and redraws the path.
- **On-Demand LLM Explanations**: Queries local Ollama (`qwen2.5-coder:3b`) on-the-fly when a node is highlighted or clicked.
- **Import Resolution**: Resolves imports (including relative paths and aliases) to disambiguate target calls.
- **SQLite Persistence**: Stores graphs inside `cody.db` for instantaneous reload.

---

## Quick Start

### 1. Prerequisites
Ensure Ollama is running and has the required coder model pulled:
```bash
ollama pull qwen2.5-coder:3b
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Run the Explorer
```bash
python main.py
```
This will start the local server and automatically open the UI dashboard in your web browser at `http://127.0.0.1:5000`.
