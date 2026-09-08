"""Golden tests for Cody's static analysis (no Ollama needed)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cody import analyzer
from cody.analyzer import (
    make_nodes, make_edges, resolve_repo, slugify_repo, is_excluded,
    resolve_node_by_name,
)

SAMPLE = os.path.join(os.path.dirname(__file__), "sample_repo")


def test_slugify():
    assert slugify_repo("https://github.com/psf/requests.git") == "requests"
    assert slugify_repo("https://github.com/x/Y/") == "y"


def test_local_repo_resolution():
    repo_dir, slug, _sha = resolve_repo(SAMPLE)
    assert os.path.isdir(repo_dir)
    assert slug  # non-empty


def test_venv_and_git_excluded():
    assert is_excluded(os.path.join(SAMPLE, "venv", "ignored.py"), SAMPLE)
    assert is_excluded(os.path.join(SAMPLE, ".git", "objects", "x"), SAMPLE)
    assert not is_excluded(os.path.join(SAMPLE, "main.py"), SAMPLE)


def _build():
    nodes, name_node, nodes_table, scope_table, file_imports = make_nodes(SAMPLE)
    adj = make_edges(name_node, nodes_table, scope_table, file_imports, SAMPLE, skip_llm=True)
    return nodes, name_node, nodes_table, adj


def test_nodes_found():
    nodes, name_node, *_ = _build()
    names = {n.name for n in nodes}
    assert {"main", "process", "helper", "worker_fn", "Foo", "bar"} <= names
    assert "should_be_ignored" not in names  # venv pruned


def test_aliased_import_edge():
    """from utils import helper as h — process() calls h() which must resolve to utils.helper"""
    nodes, name_node, nodes_table, adj = _build()
    proc_id = next(n.id for n in nodes if n.name == "process")
    helper_ids = {n.id for n in nodes if n.name == "helper"}
    targets = {t for t, _typ in adj.get(proc_id, [])}
    assert targets & helper_ids, f"process should call helper, got {targets}"


def test_main_calls_process_and_foo():
    nodes, name_node, nodes_table, adj = _build()
    main_id = next(n.id for n in nodes if n.name == "main")
    names = set()
    for t, _typ in adj.get(main_id, []):
        if t in nodes_table:
            names.add(nodes_table[t].name)
    assert "process" in names and ("Foo" in names or "bar" in names)


def test_cross_file_class_call():
    nodes, name_node, nodes_table, adj = _build()
    bar_id = next(n.id for n in nodes if n.name == "bar")
    helper_ids = {n.id for n in nodes if n.name == "helper"}
    targets = {t for t, _typ in adj.get(bar_id, [])}
    assert targets & helper_ids


def test_process_calls_helper_via_alias():
    nodes, name_node, nodes_table, adj = _build()
    proc_id = next(n.id for n in nodes if n.name == "process")
    helper_ids = {n.id for n in nodes if n.name == "helper"}
    assert {t for t, _ in adj.get(proc_id, [])} & helper_ids
