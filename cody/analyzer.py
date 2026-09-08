import os
import re
import subprocess
from collections import deque, defaultdict
from cody.parser import Node, resolve_imports_for_file, get_parser, LANG_MAP, parse_regex_symbols, get_language_parser, LANG_CONFIGS, get_node_name, extract_call_name

parser = get_parser()
SUPPORTED_EXTS = list(dict.fromkeys([".py"] + list(LANG_MAP.keys())))

# Directories/files never indexed (noise, venvs, build output, VCS internals)
IGNORE_DIRS = {
    ".git", ".hg", ".svn", ".tox", ".venv", "venv", "__pycache__",
    "node_modules", "target", "build", "dist", ".next", ".idea", ".vscode",
    ".pytest_cache", ".mypy_cache", "cloned_repo",
}
IGNORE_SUFFIXES = (".pyc", ".pyo", ".min.js", ".bundle.js", ".lock")
MAX_FILE_BYTES = 512 * 1024  # skip giant generated files

_OLLAMA_CLIENT = None


def ollama_host():
    """Where we talk to Ollama (explicit env or library default)."""
    return os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434"


def ollama_client():
    """Our own Ollama client that NEVER touches proxy env vars.

    The library's module-level singleton freezes proxy config at import time,
    so on proxied networks it routes even loopback through the office proxy
    (observed: a proxy 504 HTML page coming back as an "explanation").
    trust_env=False makes our calls proxy-proof by construction, regardless
    of import order or user env. Safe for localhost Ollama.
    """
    global _OLLAMA_CLIENT
    if _OLLAMA_CLIENT is None:
        from ollama import Client
        _OLLAMA_CLIENT = Client(host=ollama_host(), trust_env=False)
    return _OLLAMA_CLIENT


def ollama_reachable(timeout=2.0):
    """TCP-level check: is anything listening at the Ollama host?"""
    try:
        from urllib.parse import urlparse
        import socket
        u = urlparse(ollama_host())
        host = u.hostname or "127.0.0.1"
        port = u.port or (443 if u.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _norm(p):
    return os.path.normpath(os.path.abspath(p)).replace('\\', '/')


def is_excluded(path, repo_dir):
    """True if path should be skipped during analysis."""
    try:
        rel = os.path.relpath(path, repo_dir)
    except ValueError:
        return True
    parts = rel.replace('\\', '/').split('/')
    if any(part in IGNORE_DIRS for part in parts):
        return True
    low = path.lower()
    if low.endswith(IGNORE_SUFFIXES):
        return True
    try:
        if os.path.isfile(path) and os.path.getsize(path) > MAX_FILE_BYTES:
            return True
    except OSError:
        return True
    return False


def slugify_repo(source):
    import re as _re
    s = source.strip().rstrip('/').replace('\\', '/')
    if s.endswith('.git'):
        s = s[:-4]
    s = s.split('/')[-1] or 'repo'
    s = _re.sub(r'[^a-zA-Z0-9-_]+', '-', s).strip('-').lower() or 'repo'
    return s


def get_commit_sha(repo_dir):
    try:
        r = subprocess.run(["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""

def is_git_url(source):
    s = (source or "").strip()
    return s.startswith(("http://", "https://", "git@", "ssh://", "git://")) or s.endswith(".git")


def resolve_repo(source, target_dir="cloned_repo"):
    """Accept a GitHub URL *or* a local folder. Returns (repo_dir, repo_name, commit_sha).

    - Local folder: used directly, no copy, no clone.
    - Git URL: cloned once into target_dir/<slug>, pulled on re-run.
    """
    source = (source or "").strip()
    if not source:
        raise ValueError("Empty repository source")

    # Local path support (the #1 real use case: `cody .`)
    if os.path.isdir(source):
        repo_dir = _norm(source)
        name = os.path.basename(repo_dir.rstrip('/')) or "local-repo"
        return repo_dir, slugify_repo(name), get_commit_sha(repo_dir)

    if not is_git_url(source):
        # Maybe a local path with ~ or relative form
        expanded = os.path.abspath(os.path.expanduser(source))
        if os.path.isdir(expanded):
            repo_dir = _norm(expanded)
            name = os.path.basename(repo_dir.rstrip('/')) or "local-repo"
            return repo_dir, slugify_repo(name), get_commit_sha(repo_dir)
        raise ValueError(f"Not a Git URL or local folder: {source}")

    slug = slugify_repo(source)
    base = _norm(target_dir)
    os.makedirs(base, exist_ok=True)
    repo_dir = f"{base}/{slug}"

    if os.path.isdir(os.path.join(repo_dir, ".git")):
        print(f"Repo already cloned at {repo_dir}, pulling latest...")
        try:
            subprocess.run(["git", "-C", repo_dir, "pull", "--ff-only"], check=False, timeout=120)
        except Exception as e:
            print(f"[WARN] git pull failed: {e}")
        return _norm(repo_dir), slug, get_commit_sha(repo_dir)

    if os.path.exists(repo_dir):
        print(f"Repo already cloned at {repo_dir}!")
        return _norm(repo_dir), slug, get_commit_sha(repo_dir)

    print(f"Cloning {source} into {repo_dir}...")
    subprocess.run(["git", "clone", "--depth", "1", source, repo_dir], check=True, timeout=600)
    return _norm(repo_dir), slug, get_commit_sha(repo_dir)


def clone_repo(url, target_dir="cloned_repo"):
    repo_dir, _slug, _sha = resolve_repo(url, target_dir)
    return repo_dir

def make_nodes(repo_dir="cloned_repo", progress=None):
    if not os.path.exists(repo_dir):
        return [], defaultdict(list), dict(), {}, {}

    possible_nodes = []
    name_node = defaultdict(list)
    nodes_table = dict()
    scope_table = dict()
    file_imports = {}
    visited = set()
    
    repo_dir = os.path.normpath(os.path.abspath(repo_dir)).replace('\\', '/')

    for root_dir, dirs, files in os.walk(repo_dir):
        # Prune noise dirs so we never descend into venvs/build output/VCS
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith('.')]
        if is_excluded(root_dir, repo_dir):
            continue
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in SUPPORTED_EXTS:
                filename = os.path.normpath(os.path.abspath(os.path.join(root_dir, file))).replace('\\', '/')
                if is_excluded(filename, repo_dir):
                    continue
                try:
                    with open(filename, "rb") as f:
                        code_bytes = f.read()
                except OSError:
                    continue
                if progress:
                    try:
                        progress("scanning", filename)
                    except Exception:
                        pass
                
                # 1. Resolve Imports
                if ext == ".py":
                    file_imports[filename] = resolve_imports_for_file(filename, code_bytes, repo_dir)
                else:
                    file_imports[filename] = {}  # Empty local imports map for other languages
                
                # 2. Parse nodes
                lang_parser = get_language_parser(ext)
                if lang_parser and ext in LANG_CONFIGS:
                    config = LANG_CONFIGS[ext]
                    tree = lang_parser.parse(code_bytes)
                    root = tree.root_node

                    q = deque()
                    q.append((root, "__start_of_the_code_space_Cody_Term__"))

                    while len(q):
                        r, parent = q.popleft()

                        is_func = r.type in config["functions"]
                        is_class = r.type in config["classes"]

                        if is_func or is_class:
                            sp = r.start_point
                            ep = r.end_point
                            name = get_node_name(r)
                            node_type = "function_definition" if is_func else "class_definition"
                            filepath = filename
                            hierarchical_name = parent
                            
                            id_str = f"{filename}:{hierarchical_name}:{name}:{sp[0]}:{sp[1]}:{ep[0]}:{ep[1]}"
                            name_node[name].append({"id": id_str, "hierarchical_name": f"{filename}:{hierarchical_name}"})

                            if id_str not in visited:
                                n = Node(
                                    id=id_str, 
                                    name=name,
                                    hierarchical_name=hierarchical_name,
                                    type=node_type,
                                    start=sp,
                                    end=ep,
                                    indeg=0,
                                    filepath=filepath,
                                    start_byte=r.start_byte,
                                    end_byte=r.end_byte
                                )
                                possible_nodes.append(n)
                                visited.add(id_str)
                                nodes_table[id_str] = n
                                
                            scope_table[(filename, f"{hierarchical_name}:{name}")] = id_str
                            parent = f"{hierarchical_name}:{name}"

                        for child in r.children:
                            q.append((child, parent))
                else:
                    # Multi-language Regex parser fallback
                    code_str = code_bytes.decode('utf-8', errors='ignore')
                    parsed_nodes = parse_regex_symbols(filename, code_str)
                    
                    for p in parsed_nodes:
                        sp = p["start"]
                        ep = p["end"]
                        name = p["name"]
                        node_type = p["type"]
                        hierarchical_name = p["parent"]
                        
                        id_str = f"{filename}:{hierarchical_name}:{name}:{sp[0]}:{sp[1]}:{ep[0]}:{ep[1]}"
                        name_node[name].append({"id": id_str, "hierarchical_name": f"{filename}:{hierarchical_name}"})
                        
                        if id_str not in visited:
                            n = Node(
                                id=id_str,
                                name=name,
                                hierarchical_name=hierarchical_name,
                                type=node_type,
                                start=sp,
                                end=ep,
                                indeg=0,
                                filepath=filename,
                                start_byte=0,
                                end_byte=0
                            )
                            possible_nodes.append(n)
                            visited.add(id_str)
                            nodes_table[id_str] = n
                            
                        scope_table[(filename, f"{hierarchical_name}:{name}")] = id_str

    return possible_nodes, name_node, nodes_table, scope_table, file_imports

def resolve_node_by_name(from_node_id, target_name, name_node, nodes_table, file_imports, current_filepath):
    current_filepath = os.path.normpath(os.path.abspath(current_filepath)).replace('\\', '/')
    
    # 1. Imports check
    imports = file_imports.get(current_filepath, {})
    if target_name in imports:
        imp_info = imports[target_name]
        imp_actual = imp_info["actual_name"]
        imp_file = imp_info["filepath"]
        
        candidates = name_node.get(imp_actual, [])
        for cand in candidates:
            node_id = cand["id"]
            if node_id in nodes_table:
                node_filepath = os.path.normpath(nodes_table[node_id].filepath).replace('\\', '/')
                if node_filepath == imp_file:
                    return node_id

    # 2. Local check
    candidates = name_node.get(target_name, [])
    for cand in candidates:
        node_id = cand["id"]
        if node_id in nodes_table:
            node_filepath = os.path.normpath(nodes_table[node_id].filepath).replace('\\', '/')
            if node_filepath == current_filepath:
                return node_id
                
    # 3. Global unique check
    if len(candidates) == 1:
        return candidates[0]["id"]
        
    # 4. Same-folder package check
    current_dir = os.path.dirname(current_filepath)
    for cand in candidates:
        node_id = cand["id"]
        if node_id in nodes_table:
            node_filepath = os.path.normpath(nodes_table[node_id].filepath).replace('\\', '/')
            if os.path.dirname(node_filepath) == current_dir:
                return node_id
                
    # 5. Fallback
    if candidates:
        return candidates[0]["id"]
        
    return None

def get_node_source(filepath, start_byte, end_byte):
    try:
        with open(filepath, 'rb') as f:
            code_bytes = f.read()
        return code_bytes[start_byte:end_byte].decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"Error reading source bytes: {e}")
        return ""

def detect_dynamic_dispatch(code_snippet, model=None):
    try:
        prompt = (
            f"Is this line invoking a user-defined function as callback or thread target? "
            f"If yes return just the function name. If no return NULL.\n\n"
            f"{code_snippet[:2000]}"
        )
        response = ollama_client().chat(
            model=model or OLLAMA_MODEL,
            messages=[{'role': 'user', 'content': prompt}],
            options={'temperature': 0.0}
        )
        content = response['message']['content'].strip()
        content = content.replace("`", "").strip()
        if content.upper() == "NULL" or not content:
            return None
        return content
    except Exception as e:
        print(f"Ollama error in dynamic dispatch: {e}")
        return None

def find_callback_candidates(call_node, name_node):
    candidates = []
    arg_list_nodes = [c for c in call_node.children if c.type == "argument_list"]
    if not arg_list_nodes:
        return candidates
        
    arg_list = arg_list_nodes[0]
    for arg in arg_list.children:
        if arg.type == "identifier":
            name = arg.text.decode('utf-8')
            if name in name_node:
                candidates.append(name)
        elif arg.type == "keyword_argument":
            val_node = arg.child_by_field_name("value")
            if val_node and val_node.type == "identifier":
                name = val_node.text.decode('utf-8')
                if name in name_node:
                    candidates.append(name)
    return candidates

def make_edges(name_node, nodes_table, scope_table, file_imports, repo_dir="cloned_repo", progress=None, skip_llm=False):
    if not os.path.exists(repo_dir):
        return defaultdict(list)

    adj_list = defaultdict(list)
    added_edges = set()
    repo_dir = os.path.normpath(os.path.abspath(repo_dir)).replace('\\', '/')

    for root_dir, dirs, files in os.walk(repo_dir):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith('.')]
        if is_excluded(root_dir, repo_dir):
            continue
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in SUPPORTED_EXTS:
                filename = os.path.normpath(os.path.abspath(os.path.join(root_dir, file))).replace('\\', '/')
                if is_excluded(filename, repo_dir):
                    continue
                try:
                    with open(filename, "rb") as f:
                        code_bytes = f.read()
                except OSError:
                    continue
                if progress:
                    try:
                        progress("linking", filename)
                    except Exception:
                        pass

                lang_parser = get_language_parser(ext)
                if lang_parser and ext in LANG_CONFIGS:
                    config = LANG_CONFIGS[ext]
                    tree = lang_parser.parse(code_bytes)
                    root = tree.root_node

                    q = deque()
                    q.append((root, "__start_of_the_code_space_Cody_Term__"))

                    while len(q):
                        r, parent = q.popleft()

                        is_func = r.type in config["functions"]
                        is_class = r.type in config["classes"]

                        if is_func or is_class:
                            name = get_node_name(r)
                            parent = f"{parent}:{name}"

                        elif r.type in config["calls"]:
                            caller_id = scope_table.get((filename, parent))
                            if caller_id:
                                to_name = extract_call_name(r, config)

                                # 1. Resolve standard call
                                if to_name:
                                    target_id = resolve_node_by_name(caller_id, to_name, name_node, nodes_table, file_imports, filename)
                                    if target_id:
                                        # Skip self loops (recursive name clash prevention)
                                        if target_id != caller_id:
                                            edge_key = (caller_id, target_id, 'direct')
                                            if edge_key not in added_edges:
                                                adj_list[caller_id].append((target_id, 'direct'))
                                                added_edges.add(edge_key)
                                    else:
                                        lib_entity = f"library_entity:{to_name}"
                                        edge_key = (caller_id, lib_entity, 'direct')
                                        if edge_key not in added_edges:
                                            adj_list[caller_id].append((lib_entity, 'direct'))
                                            added_edges.add(edge_key)

                                # 2. Sniff dynamic dispatch (skipped in fast mode to keep analysis <10s)
                                if ext == ".py" and not skip_llm:
                                    callback_candidates = find_callback_candidates(r, name_node)
                                    if callback_candidates:
                                        code_snippet = get_node_source(filename, r.start_byte, r.end_byte)
                                        if code_snippet:
                                            detected_name = detect_dynamic_dispatch(code_snippet)
                                            if detected_name and detected_name in name_node:
                                                target_id = resolve_node_by_name(caller_id, detected_name, name_node, nodes_table, file_imports, filename)
                                                if target_id and target_id != caller_id:
                                                    edge_type = 'callback'
                                                    snippet_upper = code_snippet.upper()
                                                    if "THREAD" in snippet_upper or "TARGET=" in snippet_upper or "PROCESS" in snippet_upper:
                                                        edge_type = 'thread_target'
                                                        
                                                    edge_key = (caller_id, target_id, edge_type)
                                                    if edge_key not in added_edges:
                                                        adj_list[caller_id].append((target_id, edge_type))
                                                        added_edges.add(edge_key)

                        for child in r.children:
                            q.append((child, parent))
                else:
                    # Multi-language Regex Call analysis fallback
                    code_str = code_bytes.decode('utf-8', errors='ignore')
                    lines = code_str.splitlines()
                    
                    file_nodes = [n for n in nodes_table.values() if n.filepath == filename]
                    for node in file_nodes:
                        caller_id = node.id
                        start_row = node.start[0]
                        end_row = node.end[0]
                        body_lines = lines[start_row:end_row + 1]
                        
                        call_pat = re.compile(r'([a-zA-Z0-9_$]+)\s*\(')
                        for line_idx, line in enumerate(body_lines):
                            if line_idx == 0:
                                continue  # Skip definition line
                            
                            calls = call_pat.findall(line)
                            for to_name in calls:
                                if to_name in ["if", "for", "while", "switch", "catch", "function", "fn", "func", "return", "import", "require", "console", "log", "print", "printf"]:
                                    continue
                                    
                                target_id = resolve_node_by_name(caller_id, to_name, name_node, nodes_table, file_imports, filename)
                                if target_id and target_id != caller_id:
                                    edge_key = (caller_id, target_id, 'direct')
                                    if edge_key not in added_edges:
                                        adj_list[caller_id].append((target_id, 'direct'))
                                        added_edges.add(edge_key)
                                else:
                                    lib_entity = f"library_entity:{to_name}"
                                    edge_key = (caller_id, lib_entity, 'direct')
                                    if edge_key not in added_edges:
                                        adj_list[caller_id].append((lib_entity, 'direct'))
                                        added_edges.add(edge_key)
                        
    return adj_list

OLLAMA_MODEL = os.environ.get("CODY_MODEL", "qwen2.5-coder:3b")


def get_node_explanation(node_name, code_snippet, model=None):
    try:
        prompt = (
            f"Explain this function or class in 2-3 sentences for a developer new to this codebase. "
            f"Keep it concise, clear, and focused. Avoid introductory phrases like 'This function...' or 'Here is...'.\n\n"
            f"Entity Name: {node_name}\n"
            f"Code:\n{code_snippet[:4000]}"
        )
        response = ollama_client().chat(
            model=model or OLLAMA_MODEL,
            messages=[{'role': 'user', 'content': prompt}],
            options={'temperature': 0.2}
        )
        return response['message']['content'].strip()
    except Exception as e:
        return f"Error generating explanation: {e}"


def compute_hotspots(nodes_table, adj_list, top_n=10):
    """Complexity hotspots: highest fan-out + highest fan-in. Cheap, no LLM."""
    from collections import Counter
    fan_out = {nid: len(adj_list.get(nid, [])) for nid in nodes_table}
    fan_in = Counter()
    for frm, tos in adj_list.items():
        for to, _typ in tos:
            fan_in[to] += 1
    def top(d):
        return sorted(d.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
    return {"fan_out": top(fan_out), "fan_in": fan_in.most_common(top_n)}


def run_analysis(repo_url, db_path="cody.db", repo_dir="cloned_repo", progress=None, skip_llm=True, repo_id=None):
    from cody.database import save_to_db

    # 1. Resolve (clone URL or use local folder directly)
    actual_dir, slug, sha = resolve_repo(repo_url, repo_dir)
    actual_dir = _norm(actual_dir)
    rid = repo_id or slug

    def _prog(phase, detail=""):
        if progress:
            try:
                progress(phase, detail)
            except Exception:
                pass

    _prog("scanning", "starting")
    # 2. Make Nodes
    nodes, name_node, nodes_table, scope_table, file_imports = make_nodes(actual_dir, progress=_prog)

    _prog("linking", f"{len(nodes)} symbols found")
    # 3. Make Edges (LLM dispatch detection OFF by default for speed; on-demand later)
    adj_list = make_edges(name_node, nodes_table, scope_table, file_imports, actual_dir, progress=_prog, skip_llm=skip_llm)

    # 4. Save to Database (per-repo, no wipe)
    _prog("saving", f"{len(nodes)} nodes")
    save_to_db(nodes, adj_list, db_path, repo_id=rid,
               repo_name=slug, repo_source=repo_url, commit_sha=sha)
    _prog("done", rid)
    return actual_dir
