import os
import sys
import threading
import time
import webbrowser
import argparse

# Ensure the workspace directory is in sys.path
workspace_dir = os.path.dirname(os.path.abspath(__file__))
if workspace_dir not in sys.path:
    sys.path.insert(0, workspace_dir)

from cody.app import app


def open_browser(url):
    time.sleep(1.5)
    print(f"\n[OK] Opening Cody Web UI at {url} ...")
    webbrowser.open(url)


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="cody",
        description="Cody: Codebase Explorer — analyze any local folder or GitHub repo and walk its call graph.",
    )
    p.add_argument("source", nargs="?", default=None,
                   help="Local folder (e.g. . ) or Git URL. If omitted, serves last analysis.")
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5000")))
    p.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    p.add_argument("--no-browser", action="store_true", help="Don't auto-open the browser")
    p.add_argument("--analyze-only", action="store_true",
                   help="Analyze the source and exit without starting the server")
    return p.parse_args(argv)


def maybe_preanalyze(source):
    """`cody .` analyzes immediately so the UI opens with data."""
    if not source:
        return
    from cody.analyzer import resolve_repo, run_analysis
    from cody.app import DB_PATH, REPO_DIR
    try:
        print(f"[Cody] Analyzing {source} ...")
        actual = run_analysis(source, DB_PATH, REPO_DIR, skip_llm=True)
        print(f"[OK] Analysis complete: {actual}")
    except Exception as e:
        print(f"[WARN] Pre-analysis failed ({e}). You can retry from the UI.")


def main(argv=None):
    args = parse_args(argv)
    url = f"http://{args.host}:{args.port}"

    print("======================================================================")
    print("                      CODY: CODEBASE EXPLORER                         ")
    print("======================================================================")
    if args.source:
        print(f"Source: {args.source}")
    print(f"DB: {os.environ.get('CODY_DB', 'cody.db')}  Model: {os.environ.get('CODY_MODEL', 'qwen2.5-coder:3b')}")

    if args.analyze_only and args.source:
        maybe_preanalyze(args.source)
        return 0

    if args.source:
        # Pre-analyze in background so server boots fast even on big repos
        threading.Thread(target=maybe_preanalyze, args=(args.source,), daemon=True).start()

    if not args.no_browser:
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()

    app.run(host=args.host, port=args.port, debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
