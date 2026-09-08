"""API + DB tests: multi-repo isolation, search, relations, walkthrough."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cody.analyzer import run_analysis
from cody.database import (
    get_nodes_and_edges, search_nodes, get_relations, get_files, list_repos,
    get_cached_explanation, save_explanation,
)

SAMPLE = os.path.join(os.path.dirname(__file__), "sample_repo")


def _analyze_to_tmp():
    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "test.db")
    run_analysis(SAMPLE, db_path=db, repo_dir=SAMPLE, skip_llm=True, repo_id="sample")
    return db


def test_full_pipeline_and_multi_repo():
    db = _analyze_to_tmp()
    nodes, edges = get_nodes_and_edges(db, repo_id="sample")
    assert len(nodes) >= 6
    assert len(edges) >= 3

    # Second repo must not wipe the first (old bug: save_to_db deleted everything)
    run_analysis(SAMPLE, db_path=db, repo_dir=SAMPLE, skip_llm=True, repo_id="sample2")
    nodes1, _ = get_nodes_and_edges(db, repo_id="sample")
    nodes2, _ = get_nodes_and_edges(db, repo_id="sample2")
    assert len(nodes1) >= 6 and len(nodes2) >= 6
    assert len(list_repos(db)) >= 2


def test_search_files_relations():
    db = _analyze_to_tmp()
    assert any(n["name"] == "helper" for n in search_nodes("help", db, repo_id="sample"))
    assert any("main.py" in f["filepath"] for f in get_files(db, repo_id="sample"))

    nodes, _ = get_nodes_and_edges(db, repo_id="sample")
    helper_id = next(n["id"] for n in nodes if n["name"] == "helper")
    rel = get_relations(helper_id, db, repo_id="sample")
    assert len(rel["inbound"]) >= 2  # process, bar, worker_fn call helper


def test_explanation_cache():
    db = _analyze_to_tmp()
    assert get_cached_explanation("nope", db) is None
    save_explanation("n1", "hello", db, repo_id="sample", model="t")
    assert get_cached_explanation("n1", db)["explanation"] == "hello"


def test_flask_endpoints():
    os.environ["CODY_DB"] = tempfile.mktemp(suffix=".db")
    import importlib
    import cody.app as appmod
    importlib.reload(appmod)
    appmod.run_analysis(SAMPLE, appmod.DB_PATH, SAMPLE, skip_llm=True)
    c = appmod.app.test_client()
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/graph").status_code == 200
    assert c.get("/api/search?q=helper").status_code == 200
    assert c.get("/api/files").status_code == 200
    assert c.get("/api/hotspots").status_code == 200
    assert c.get("/api/walkthrough").status_code == 200
    # async analyze
    r = c.post("/api/analyze", json={"source": SAMPLE})
    assert r.status_code == 200 and "job_id" in r.get_json()


def test_error_explanations_never_cached():
    """Regression: a failed Ollama call (e.g. office-proxy 504 HTML) must not be
    stored, and poisoned rows from the old bug must be purged."""
    import importlib
    from unittest import mock
    from cody.database import purge_error_cache, get_cached_explanation

    os.environ["CODY_DB"] = tempfile.mktemp(suffix=".db")
    import cody.app as appmod
    importlib.reload(appmod)
    appmod.run_analysis(SAMPLE, appmod.DB_PATH, SAMPLE, skip_llm=True)
    c = appmod.app.test_client()

    nodes, _ = appmod.get_nodes_and_edges(appmod.DB_PATH)
    helper_id = next(n["id"] for n in nodes if n["name"] == "helper")

    # 1. Simulate the old bug: a proxy-504 failure string sitting in cache
    conn_holder = {}
    import sqlite3
    conn = sqlite3.connect(appmod.DB_PATH)
    conn.execute(
        "INSERT OR REPLACE INTO explanations (node_id, repo_id, model, text, updated_at)"
        " VALUES (?, 'default', 't', ?, 1)",
        (helper_id, "Error generating explanation: <html>GATEWAY_TIMEOUT</html>"))
    conn.commit()
    conn.close()
    assert purge_error_cache(appmod.DB_PATH) >= 1
    assert get_cached_explanation(helper_id, appmod.DB_PATH) is None

    # 2. Fresh Ollama failure must be returned but NOT stored
    fake = mock.MagicMock()
    fake.chat.side_effect = Exception("boom-proxy")
    with mock.patch("cody.analyzer.ollama_client", return_value=fake), \
         mock.patch("cody.app.ollama_client", return_value=fake):
        r = c.get("/api/node/explain", query_string={"node_id": helper_id})
        assert r.status_code == 200
        assert "boom-proxy" in r.get_json()["explanation"]
    assert get_cached_explanation(helper_id, appmod.DB_PATH) is None

    # 3. Successful explanations still cache normally
    fake.chat.side_effect = None
    fake.chat.return_value = {"message": {"content": "does things"}}
    with mock.patch("cody.analyzer.ollama_client", return_value=fake), \
         mock.patch("cody.app.ollama_client", return_value=fake):
        r = c.get("/api/node/explain", query_string={"node_id": helper_id})
        assert r.get_json()["explanation"] == "does things"
    assert get_cached_explanation(helper_id, appmod.DB_PATH)["explanation"] == "does things"


def test_chat_identity_pinned():
    """Cody must identify as the local Qwen-powered assistant, never OpenAI/etc."""
    import importlib
    from unittest import mock
    os.environ["CODY_DB"] = tempfile.mktemp(suffix=".db")
    import cody.app as appmod
    importlib.reload(appmod)
    appmod.run_analysis(SAMPLE, appmod.DB_PATH, SAMPLE, skip_llm=True)
    c = appmod.app.test_client()
    nodes, _ = appmod.get_nodes_and_edges(appmod.DB_PATH)
    nid = next(n["id"] for n in nodes if n["name"] == "helper")
    fake = mock.MagicMock()
    fake.chat.return_value = {"message": {"content": "hi"}}
    with mock.patch("cody.analyzer.ollama_client", return_value=fake), \
         mock.patch("cody.app.ollama_client", return_value=fake):
        r = c.post("/api/chat", json={"node_id": nid, "message": "who are you?"})
        assert r.status_code == 200
    system = fake.chat.call_args[1]["messages"][0]["content"]
    assert "powered by" in system and "locally via Ollama" in system
    assert "Never claim" in system


def test_ollama_client_ignores_proxy_env():
    """Cody's Ollama client must bypass proxies even with NO_PROXY unset."""
    import httpx
    import cody.analyzer as az

    old = dict(os.environ)
    az._OLLAMA_CLIENT = None
    try:
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:9"
        os.environ.pop("NO_PROXY", None)
        os.environ.pop("no_proxy", None)
        t = az.ollama_client()._client._transport_for_url(
            httpx.URL("http://127.0.0.1:11434/api/chat"))
        assert type(t).__name__ == "HTTPTransport", f"proxied: {type(t).__name__}"
    finally:
        os.environ.clear()
        os.environ.update(old)
        az._OLLAMA_CLIENT = None
