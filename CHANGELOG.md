# Changelog

All notable changes to Cody. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0] — 2026-09-09 (first public release)

Cody Maps: paste any Python repo link or local path, get an interactive
Google-Maps-style call graph with a guided trip, plain-English explanations,
and grounded Q&A — all offline via local Ollama. Nothing leaves the laptop.

### Added
- Maps UI: force-directed city layout (related places cluster), districts as
  neighborhood labels, yellow highway arterials, thin local streets, river +
  external-library land, red drop pins, blue guided-trip routes with numbered
  stops, traveler dot, search autocomplete, Map/Satellite themes, layers menu
  (libraries, labels, tests/examples, minimap), draggable minimap inset with
  viewport box + click-to-travel, back/forward place history, scale bar.
- Place cards: Overview (AI explanation + callers/callees chips) / Code / Q&A
  tabs, Route-Nearby-Ask-Copy actions, clipboard + toast feedback.
- Backend: multi-repo SQLite store, async analyze jobs with progress polling,
  `/api/search, /files, /node/relations, /hotspots, /repos, /health`
  (Ollama reachability + proxy diagnostics), explanation cache that never
  stores failures, stale-error purge on boot, proxy-immune Ollama client
  (`trust_env=False`), pinned AI identity (local Qwen, never Big-AI cosplay).
- Analysis: local-folder or Git URL input, shallow clone + pull on re-run,
  venv/build/.git/giant-file exclusion, fast LLM-free indexing,
  Python import-alias resolution, 5-tier callee cascade.
- Packaging: `python main.py .` CLI, pinned `requirements.txt`, Dockerfile,
  VS Code extension v0.1.0 (sidebar, search-to-definition, map panel, F5 ready).
- Tests: 15 pytest cases (golden sample repo, multi-repo isolation,
  proxy-immunity, identity pinning) + Node layout harness proving related-close.

### Known limits (honest)
- Python-first: other languages fall back to best-effort parsing.
- `tests/`/`examples/` hidden by default (toggle in Layers).
- Needs Ollama + `qwen2.5-coder:3b` for AI text; map/search work without it.
