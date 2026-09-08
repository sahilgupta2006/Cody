import os
import sqlite3
import time


def _connect(db_path="cody.db"):
    db_path = os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path="cody.db"):
    conn = _connect(db_path)
    cursor = conn.cursor()

    # Non-destructive migration: legacy DBs (pre-multi-repo) have nodes(id PK) with
    # no repo_id column. Rebuild as (id, repo_id) PK preserving all rows.
    try:
        row = cursor.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'").fetchone()
        sql = (row["sql"] if row else "") or ""
        if row is not None and "repo_id" not in sql:
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS nodes_new (
                id TEXT, name TEXT, hierarchical_name TEXT, type TEXT,
                start_row INTEGER, end_row INTEGER, filepath TEXT,
                repo_id TEXT DEFAULT 'default', PRIMARY KEY (id, repo_id))
            """)
            cursor.execute("""
            INSERT OR IGNORE INTO nodes_new (id, name, hierarchical_name, type, start_row, end_row, filepath, repo_id)
            SELECT id, name, hierarchical_name, type, start_row, end_row, filepath, 'default' FROM nodes
            """)
            cursor.execute("DROP TABLE nodes")
            cursor.execute("ALTER TABLE nodes_new RENAME TO nodes")

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS edges_new (
                from_node TEXT, to_node TEXT, type TEXT, repo_id TEXT DEFAULT 'default')
            """)
            try:
                cursor.execute("""
                INSERT INTO edges_new (from_node, to_node, type, repo_id)
                SELECT from_node, to_node, type, 'default' FROM edges
                """)
                cursor.execute("DROP TABLE edges")
                cursor.execute("ALTER TABLE edges_new RENAME TO edges")
            except Exception:
                pass
            cursor.execute("DROP TABLE IF EXISTS explanations")
    except Exception as e:
        print(f"[WARN] migration failed: {e}")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT,
        name TEXT,
        hierarchical_name TEXT,
        type TEXT,
        start_row INTEGER,
        end_row INTEGER,
        filepath TEXT,
        repo_id TEXT DEFAULT 'default',
        PRIMARY KEY (id, repo_id)
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS edges (
        from_node TEXT,
        to_node TEXT,
        type TEXT,
        repo_id TEXT DEFAULT 'default'
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT,
        source TEXT,
        commit_sha TEXT,
        created_at REAL,
        node_count INTEGER DEFAULT 0,
        edge_count INTEGER DEFAULT 0
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS explanations (
        node_id TEXT,
        repo_id TEXT DEFAULT 'default',
        model TEXT,
        text TEXT,
        updated_at REAL,
        PRIMARY KEY (node_id, repo_id)
    )
    """)

    # Lightweight migrations for DBs created by older Cody versions
    for table, col, ddl in [
        ("nodes", "repo_id", "ALTER TABLE nodes ADD COLUMN repo_id TEXT DEFAULT 'default'"),
        ("edges", "repo_id", "ALTER TABLE edges ADD COLUMN repo_id TEXT DEFAULT 'default'"),
    ]:
        try:
            cols = [r[1] for r in cursor.execute(f"PRAGMA table_info({table})").fetchall()]
            if col not in cols:
                cursor.execute(ddl)
        except Exception:
            pass

    try:
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_nodes_repo ON nodes(repo_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_edges_repo ON edges(repo_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node)")
    except Exception:
        pass

    conn.commit()
    conn.close()


def ensure_legacy_repo(db_path="cody.db"):
    """Old DBs have nodes but no repos row — register them so the selector works."""
    try:
        conn = _connect(db_path)
        n = conn.execute("SELECT COUNT(*) as c FROM nodes").fetchone()["c"]
        r = conn.execute("SELECT COUNT(*) as c FROM repos").fetchone()["c"]
        if n and not r:
            import time as _t
            conn.execute(
                "INSERT OR IGNORE INTO repos (id, name, source, commit_sha, created_at, node_count, edge_count) VALUES (?,?,?,?,?,?,?)",
                ("legacy", "legacy", "", "", _t.time(), n,
                 conn.execute("SELECT COUNT(*) as c FROM edges").fetchone()["c"]))
            conn.commit()
        conn.close()
    except Exception:
        pass
def save_to_db(nodes, edges, db_path="cody.db", repo_id="default",
               repo_name="", repo_source="", commit_sha=""):
    init_db(db_path)
    conn = _connect(db_path)
    cursor = conn.cursor()

    # Replace only this repo's graph (multi-repo safe, unlike old wipe-everything)
    cursor.execute("DELETE FROM nodes WHERE repo_id = ?", (repo_id,))
    cursor.execute("DELETE FROM edges WHERE repo_id = ?", (repo_id,))

    for node in nodes:
        cursor.execute(
            "INSERT OR REPLACE INTO nodes (id, name, hierarchical_name, type, start_row, end_row, filepath, repo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (node.id, node.name, node.hierarchical_name, node.type, node.start[0], node.end[0], node.filepath, repo_id)
        )

    edge_count = 0
    for from_node, to_list in edges.items():
        for to_node, edge_type in to_list:
            cursor.execute(
                "INSERT INTO edges (from_node, to_node, type, repo_id) VALUES (?, ?, ?, ?)",
                (from_node, to_node, edge_type, repo_id)
            )
            edge_count += 1

    cursor.execute(
        "INSERT OR REPLACE INTO repos (id, name, source, commit_sha, created_at, node_count, edge_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (repo_id, repo_name or repo_id, repo_source or "", commit_sha or "", time.time(), len(nodes), edge_count)
    )

    conn.commit()
    conn.close()
    print(f"[OK] Database saved: {db_path} repo={repo_id} nodes={len(nodes)} edges={edge_count}")


def _row_to_node(r):
    return {
        "id": r["id"],
        "name": r["name"],
        "hierarchical_name": r["hierarchical_name"],
        "type": r["type"],
        "start_row": r["start_row"],
        "end_row": r["end_row"],
        "filepath": r["filepath"],
    }


def get_nodes_and_edges(db_path="cody.db", repo_id=None):
    if not os.path.exists(os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')):
        return [], []
    init_db(db_path)
    conn = _connect(db_path)
    cursor = conn.cursor()

    if repo_id is None:
        # Default to most recently created repo (multi-repo safe)
        row = cursor.execute("SELECT id FROM repos ORDER BY created_at DESC LIMIT 1").fetchone()
        if row:
            repo_id = row["id"]

    if repo_id:
        node_rows = cursor.execute(
            "SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes WHERE repo_id = ?", (repo_id,)
        ).fetchall()
        edge_rows = cursor.execute(
            "SELECT from_node, to_node, type FROM edges WHERE repo_id = ?", (repo_id,)
        ).fetchall()
    else:
        node_rows = cursor.execute("SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes").fetchall()
        edge_rows = cursor.execute("SELECT from_node, to_node, type FROM edges").fetchall()

    nodes = [_row_to_node(r) for r in node_rows]
    edges = [{"from": r["from_node"], "to": r["to_node"], "type": r["type"]} for r in edge_rows]
    conn.close()
    return nodes, edges


def get_node_by_id(node_id, db_path="cody.db", repo_id=None):
    if not os.path.exists(os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')):
        return None
    init_db(db_path)
    conn = _connect(db_path)
    cursor = conn.cursor()
    if repo_id:
        r = cursor.execute("SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes WHERE id = ? AND repo_id = ?", (node_id, repo_id)).fetchone()
    else:
        r = cursor.execute("SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes WHERE id = ?", (node_id,)).fetchone()
    conn.close()
    if r:
        return _row_to_node(r)
    return None


def list_repos(db_path="cody.db"):
    if not os.path.exists(os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')):
        return []
    init_db(db_path)
    conn = _connect(db_path)
    rows = conn.execute("SELECT id, name, source, commit_sha, created_at, node_count, edge_count FROM repos ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_nodes(query, db_path="cody.db", repo_id=None, limit=50):
    if not query or not os.path.exists(os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')):
        return []
    init_db(db_path)
    conn = _connect(db_path)
    like = f"%{query}%"
    if repo_id:
        rows = conn.execute(
            "SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes WHERE repo_id = ? AND (name LIKE ? OR filepath LIKE ?) ORDER BY name LIMIT ?",
            (repo_id, like, like, limit)).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes WHERE name LIKE ? OR filepath LIKE ? ORDER BY name LIMIT ?",
            (like, like, limit)).fetchall()
    conn.close()
    return [_row_to_node(r) for r in rows]


def get_files(db_path="cody.db", repo_id=None):
    """Return [{filepath, count}] for file-tree sidebar."""
    if not os.path.exists(os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')):
        return []
    init_db(db_path)
    conn = _connect(db_path)
    if repo_id:
        rows = conn.execute("SELECT filepath, COUNT(*) as c FROM nodes WHERE repo_id = ? GROUP BY filepath ORDER BY filepath", (repo_id,)).fetchall()
    else:
        rows = conn.execute("SELECT filepath, COUNT(*) as c FROM nodes GROUP BY filepath ORDER BY filepath").fetchall()
    conn.close()
    return [{"filepath": r["filepath"], "count": r["c"]} for r in rows]


def get_relations(node_id, db_path="cody.db", repo_id=None):
    """Inbound (called-by) + outbound (calls) for a node. Fixes 'only outbound' gap."""
    if not os.path.exists(os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')):
        return {"inbound": [], "outbound": []}
    init_db(db_path)
    conn = _connect(db_path)
    if repo_id:
        out_rows = conn.execute("SELECT from_node, to_node, type FROM edges WHERE from_node = ? AND repo_id = ?", (node_id, repo_id)).fetchall()
        in_rows = conn.execute("SELECT from_node, to_node, type FROM edges WHERE to_node = ? AND repo_id = ?", (node_id, repo_id)).fetchall()
    else:
        out_rows = conn.execute("SELECT from_node, to_node, type FROM edges WHERE from_node = ?", (node_id,)).fetchall()
        in_rows = conn.execute("SELECT from_node, to_node, type FROM edges WHERE to_node = ?", (node_id,)).fetchall()
    conn.close()

    def edge_to_dict(r, direction):
        other_id = r["to_node"] if direction == "out" else r["from_node"]
        other = get_node_by_id(other_id, db_path, repo_id)
        return {
            "from": r["from_node"], "to": r["to_node"], "type": r["type"],
            "other_id": other_id,
            "other_name": other["name"] if other else other_id.split(":", 1)[1] if other_id.startswith("library_entity:") else other_id,
            "other_file": other["filepath"] if other else "External",
        }

    return {
        "outbound": [edge_to_dict(r, "out") for r in out_rows],
        "inbound": [edge_to_dict(r, "in") for r in in_rows],
    }


def get_cached_explanation(node_id, db_path="cody.db", repo_id=None):
    if not os.path.exists(os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')):
        return None
    init_db(db_path)
    conn = _connect(db_path)
    r = conn.execute("SELECT text, model FROM explanations WHERE node_id = ?", (node_id,)).fetchone()
    conn.close()
    return {"explanation": r["text"], "model": r["model"], "cached": True} if r else None


def save_explanation(node_id, text, db_path="cody.db", repo_id="default", model=""):
    # Never cache failure strings — a poisoned cache replays stale errors forever
    # (this exact bug once served a week-old proxy 504 as an "explanation").
    if (text or "").startswith("Error generating explanation:"):
        return False
    init_db(db_path)
    conn = _connect(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO explanations (node_id, repo_id, model, text, updated_at) VALUES (?, ?, ?, ?, ?)",
        (node_id, repo_id, model, text, time.time()))
    conn.commit()
    conn.close()
    return True


def purge_error_cache(db_path="cody.db"):
    """Delete previously cached failure strings. Returns rows removed."""
    try:
        init_db(db_path)
        conn = _connect(db_path)
        cur = conn.execute(
            "DELETE FROM explanations WHERE text LIKE 'Error generating explanation:%'")
        n = cur.rowcount or 0
        conn.commit()
        conn.close()
        if n:
            print(f"[OK] Purged {n} stale error(s) from explanation cache")
        return n
    except Exception as e:
        print(f"[WARN] purge_error_cache failed: {e}")
        return 0
