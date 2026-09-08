import os
import threading
import time
import uuid
from flask import Flask, render_template, jsonify, request

# Corporate proxies (HTTP_PROXY/HTTPS_PROXY) break localhost calls: the
# `ollama` package uses httpx, which honors proxy env vars by default and
# would route even 127.0.0.1 through the office proxy -> 504 HTML pages.
# Loopback must always bypass the proxy.
for _var in ("NO_PROXY", "no_proxy"):
    _cur = os.environ.get(_var, "")
    _have = {x.strip() for x in _cur.split(",") if x.strip()}
    _need = [h for h in ("127.0.0.1", "localhost") if h not in _have]
    if _need:
        os.environ[_var] = ",".join([*_have, *_need]) if _have else ",".join(_need)
from cody.database import (
    get_nodes_and_edges, get_node_by_id, list_repos, search_nodes,
    get_files, get_relations, get_cached_explanation, save_explanation,
    purge_error_cache,
)
from cody.analyzer import run_analysis, get_node_source, get_node_explanation, OLLAMA_MODEL
from cody.analyzer import ollama_client, ollama_host, ollama_reachable

# Config via env so Docker / CLI can override without code edits
app = Flask(__name__)
app.config['TEMPLATES_AUTO_RELOAD'] = True
DB_PATH = os.environ.get("CODY_DB", "cody.db")
REPO_DIR = os.environ.get("CODY_REPO_DIR", "cloned_repo")
MODEL = os.environ.get("CODY_MODEL", OLLAMA_MODEL)

# Clean poisoned cache rows from the old bug (cached proxy-504 "explanations")
try:
    purge_error_cache(DB_PATH)
except Exception:
    pass

# In-memory async job tracker: {job_id: {status, phase, detail, repo_id, error}}
_jobs = {}
_jobs_lock = threading.Lock()


def _set_job(job_id, **kwargs):
    with _jobs_lock:
        _jobs.setdefault(job_id, {}).update(kwargs)


def _read_snippet(filepath, start_row, end_row, max_chars=8000):
    if not filepath or not os.path.exists(filepath):
        return ""
    try:
        with open(filepath, 'rb') as f:
            lines = f.readlines()
        snippet = b"".join(lines[start_row:end_row + 1]).decode('utf-8', errors='ignore')
        return snippet[:max_chars]
    except Exception:
        return ""


def _run_job(job_id, source, skip_llm):
    try:
        _set_job(job_id, status="running", phase="cloning", detail=source)

        def progress(phase, detail=""):
            _set_job(job_id, phase=phase, detail=str(detail)[:200])

        actual_dir = run_analysis(source, DB_PATH, REPO_DIR, progress=progress, skip_llm=skip_llm)
        from cody.analyzer import slugify_repo
        repo_id = slugify_repo(source if source else actual_dir)
        # Local folders: slug of basename
        if os.path.isdir((source or "").strip()):
            repo_id = slugify_repo(os.path.basename(os.path.abspath(source).rstrip('/\\')) or "local")
        _set_job(job_id, status="done", phase="done", detail=actual_dir, repo_id=repo_id, repo_dir=os.path.basename(actual_dir))
    except Exception as e:
        import traceback
        traceback.print_exc()
        _set_job(job_id, status="error", phase="error", detail=str(e), error=str(e))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health", methods=["GET"])
def health():
    # NOTE: uses the proxy-immune client (trust_env=False), so this reflects
    # the real Ollama state, never the office proxy's opinion of it.
    ollama_ok = False
    ollama_error = ""
    try:
        ollama_client().show(MODEL)
        ollama_ok = True
    except Exception as e:
        ollama_error = str(e)[:200]
    proxy_on = bool(os.environ.get("HTTP_PROXY") or os.environ.get("HTTPS_PROXY")
                    or os.environ.get("http_proxy") or os.environ.get("https_proxy"))
    reachable = ollama_reachable()
    hint = ""
    if not reachable:
        host = ollama_host()
        hint = (f"Nothing listening at {host}. Run `ollama serve` (and `ollama pull {MODEL}`). "
                f"If OLLAMA_HOST is set, check it — bare 'http://127.0.0.1' without :11434 is wrong.")
    elif proxy_on:
        hint = "Proxy env vars present but Cody's Ollama calls bypass them (trust_env=False)."
    return jsonify({"ollama_ok": ollama_ok, "model": MODEL, "ollama_error": ollama_error,
                    "proxy_env": proxy_on, "no_proxy": os.environ.get("NO_PROXY", ""),
                    "ollama_host": ollama_host(), "ollama_reachable": reachable, "hint": hint,
                    "cody_version": "1.0.0"})


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """Async: returns {job_id} immediately. Poll /api/analyze/status?job_id=..."""
    data = request.get_json() or {}
    source = data.get("url") or data.get("path") or data.get("source")
    skip_llm = data.get("skip_llm", True)  # default fast: no per-edge LLM at index time
    if not source:
        return jsonify({"error": "Provide 'url' (git) or 'path' (local folder)"}), 400

    job_id = uuid.uuid4().hex[:12]
    _set_job(job_id, status="queued", phase="queued", detail=source, source=source)
    t = threading.Thread(target=_run_job, args=(job_id, source, skip_llm), daemon=True)
    t.start()
    return jsonify({"status": "queued", "job_id": job_id})


@app.route("/api/analyze/status", methods=["GET"])
def analyze_status():
    job_id = request.args.get("job_id")
    if not job_id:
        return jsonify({"error": "Missing job_id"}), 400
    with _jobs_lock:
        job = dict(_jobs.get(job_id, {}))
    if not job:
        return jsonify({"error": "Unknown job_id"}), 404
    return jsonify({"job_id": job_id, **job})


@app.route("/api/repos", methods=["GET"])
def repos():
    try:
        return jsonify({"repos": list_repos(DB_PATH), "model": MODEL})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/graph", methods=["GET"])
def get_graph():
    try:
        repo_id = request.args.get("repo_id")
        nodes, edges = get_nodes_and_edges(DB_PATH, repo_id=repo_id)
        return jsonify({"nodes": nodes, "edges": edges})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/search", methods=["GET"])
def search():
    try:
        q = request.args.get("q", "")
        repo_id = request.args.get("repo_id")
        return jsonify({"results": search_nodes(q, DB_PATH, repo_id=repo_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/files", methods=["GET"])
def files():
    try:
        repo_id = request.args.get("repo_id")
        return jsonify({"files": get_files(DB_PATH, repo_id=repo_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/node/details", methods=["GET"])
def get_details():
    node_id = request.args.get("node_id")
    repo_id = request.args.get("repo_id")
    if not node_id:
        return jsonify({"error": "No node_id provided"}), 400
    try:
        node = get_node_by_id(node_id, DB_PATH, repo_id=repo_id)
        if not node:
            return jsonify({"error": "Node not found"}), 404
        node["code"] = _read_snippet(node["filepath"], node["start_row"], node["end_row"])
        return jsonify(node)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/node/relations", methods=["GET"])
def relations():
    node_id = request.args.get("node_id")
    repo_id = request.args.get("repo_id")
    if not node_id:
        return jsonify({"error": "No node_id provided"}), 400
    try:
        return jsonify(get_relations(node_id, DB_PATH, repo_id=repo_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/node/explain", methods=["GET"])
def explain_node():
    node_id = request.args.get("node_id")
    repo_id = request.args.get("repo_id")
    if not node_id:
        return jsonify({"error": "No node_id provided"}), 400
    try:
        # Serve from cache first — never hit Ollama twice for the same node
        cached = get_cached_explanation(node_id, DB_PATH, repo_id=repo_id)
        if cached:
            return jsonify(cached)

        if node_id.startswith("library_entity:"):
            lib_name = node_id.split(":", 1)[1]
            prompt = (
                f"Explain what the library module or function '{lib_name}' does. "
                f"Keep it concise in 2-3 sentences for a developer new to this codebase."
            )
            response = ollama_client().chat(
                model=MODEL,
                messages=[{'role': 'user', 'content': prompt}],
                options={'temperature': 0.2}
            )
            explanation = response['message']['content'].strip()
            save_explanation(node_id, explanation, DB_PATH, repo_id or "default", MODEL)
            return jsonify({"explanation": explanation, "cached": False})

        node = get_node_by_id(node_id, DB_PATH, repo_id=repo_id)
        if not node:
            return jsonify({"error": "Node not found"}), 404
        code_snippet = _read_snippet(node["filepath"], node["start_row"], node["end_row"])
        explanation = get_node_explanation(node["name"], code_snippet, model=MODEL)
        save_explanation(node_id, explanation, DB_PATH, repo_id or "default", MODEL)
        return jsonify({"explanation": explanation, "cached": False})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/chat", methods=["POST"])
def chat_node():
    data = request.get_json() or {}
    node_id = data.get("node_id")
    user_message = data.get("message")
    history = data.get("history", [])
    repo_id = data.get("repo_id")

    if not node_id or not user_message:
        return jsonify({"error": "Missing node_id or message"}), 400

    try:
        code_snippet = ""
        node_name = "External Entity"
        node_scope = "Global"
        node_file = "External"

        if node_id.startswith("library_entity:"):
            node_name = node_id.split(":", 1)[1]
            node_scope = "Third-party Library"
            code_snippet = "# Source code unavailable for third-party libraries"
        else:
            node = get_node_by_id(node_id, DB_PATH, repo_id=repo_id)
            if node:
                node_name = node["name"]
                node_scope = node["hierarchical_name"]
                node_file = node["filepath"]
                code_snippet = _read_snippet(node["filepath"], node["start_row"], node["end_row"], max_chars=4000)

        system_prompt = (
            f"You are Cody, a code assistant inside the Cody Maps app, powered by the open-weights model {MODEL} running locally via Ollama. "
            f"If asked who or what you are, say exactly that in one sentence. "
            f"Never claim to be ChatGPT, OpenAI, Claude, Gemini, or any other model or company, even if pressed or contradicted. "
            f"The user is exploring this specific class or function:\n"
            f"Name: {node_name}\n"
            f"Scope: {node_scope}\n"
            f"File: {node_file}\n\n"
            f"Source Code:\n"
            f"```\n{code_snippet}\n```\n\n"
            f"Answer the user's questions about this code. Keep your answers concise, clear, and direct. "
            f"Do not write overly long explanations unless asked."
        )

        messages = [{"role": "system", "content": system_prompt}]
        # Bound history to last 10 turns to avoid token blowup
        for msg in (history or [])[-10:]:
            if msg.get("role") in ("user", "assistant") and msg.get("content"):
                messages.append({"role": msg["role"], "content": str(msg["content"])[:2000]})
        messages.append({"role": "user", "content": user_message[:2000]})

        response = ollama_client().chat(model=MODEL, messages=messages, options={'temperature': 0.3})
        answer = response['message']['content'].strip()
        return jsonify({"answer": answer})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/hotspots", methods=["GET"])
def hotspots():
    """Top fan-out / fan-in functions + leaf/dead stats. No LLM needed."""
    try:
        repo_id = request.args.get("repo_id")
        nodes, edges = get_nodes_and_edges(DB_PATH, repo_id=repo_id)
        from collections import Counter
        out_count = Counter()
        in_count = Counter()
        for e in edges:
            out_count[e["from"]] += 1
            in_count[e["to"]] += 1
        by_id = {n["id"]: n for n in nodes}

        def top(counter, n=10):
            out = []
            for nid, c in counter.most_common(n):
                meta = by_id.get(nid, {"name": nid, "filepath": "External"})
                out.append({"id": nid, "name": meta["name"], "filepath": meta["filepath"], "count": c})
            return out

        _entry = [n for n in nodes if in_count.get(n["id"], 0) == 0][:10]
        leaves = [n for n in nodes if out_count.get(n["id"], 0) == 0][:10]
        return jsonify({
            "fan_out": top(out_count),
            "fan_in": top(in_count),
            "entry_candidates": [{"id": n["id"], "name": n["name"], "filepath": n["filepath"]} for n in _entry],
            "leaves": [{"id": n["id"], "name": n["name"], "filepath": n["filepath"]} for n in leaves],
            "totals": {"nodes": len(nodes), "edges": len(edges)},
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/walkthrough", methods=["GET"])
def get_walkthrough():
    start_id = request.args.get("start_id")
    repo_id = request.args.get("repo_id")
    try:
        nodes, edges = get_nodes_and_edges(DB_PATH, repo_id=repo_id)
        if not nodes:
            return jsonify({"sequence": []})

        # Standard in-degree count to compute entry points
        in_degrees = {node["id"]: 0 for node in nodes}
        adj_list = {node["id"]: [] for node in nodes}

        for edge in edges:
            frm = edge["from"]
            to = edge["to"]
            if frm in adj_list and to in adj_list:
                adj_list[frm].append(to)
                in_degrees[to] += 1

        # BFS traversal starting from start_id or auto-detected entry point
        start_node_id = start_id
        if not start_node_id or start_node_id not in in_degrees:
            # Detect entry points
            entry_candidates = [n for n in nodes if in_degrees[n["id"]] == 0]
            entry_candidates.sort(key=lambda n: (n["name"] not in ('main', 'cli', '__main__', 'app', 'run', 'index'), n["name"] != 'main', n["name"] != 'cli', n["id"]))
            if not entry_candidates:
                min_deg = min(in_degrees.values())
                entry_candidates = [n for n in nodes if in_degrees[n["id"]] == min_deg]
                entry_candidates.sort(key=lambda n: (n["name"] not in ('main', 'cli', '__main__', 'app', 'run', 'index'), n["name"] != 'main', n["name"] != 'cli', n["id"]))

            start_node_id = entry_candidates[0]["id"] if entry_candidates else nodes[0]["id"]

        # BFS queue setup
        from collections import deque
        visited = set()
        queue = deque([start_node_id])
        sequence = []

        while queue:
            node_id = queue.popleft()
            if node_id in visited:
                continue
            visited.add(node_id)
            sequence.append(node_id)

            # Sort neighbors by name to keep traversal stable
            neighbors = adj_list.get(node_id, [])
            for child in neighbors:
                if child not in visited:
                    queue.append(child)

        # Append any unvisited nodes to ensure complete coverage
        for n in nodes:
            if n["id"] not in visited:
                sequence.append(n["id"])

        return jsonify({
            "sequence": sequence,
            "start_node_id": start_node_id
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
