import os
from flask import Flask, render_template, jsonify, request
from cody.database import get_nodes_and_edges, get_node_by_id
from cody.analyzer import run_analysis, get_node_source, get_node_explanation

# We initialize the Flask app pointing to the correct package structure
app = Flask(__name__)
DB_PATH = "cody.db"
REPO_DIR = "cloned_repo"

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.get_json() or {}
    url = data.get("url")
    if not url:
        return jsonify({"error": "No URL provided"}), 400
        
    try:
        actual_repo_dir = run_analysis(url, DB_PATH, REPO_DIR)
        return jsonify({
            "status": "success", 
            "repo_dir": os.path.basename(actual_repo_dir)
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/graph", methods=["GET"])
def get_graph():
    try:
        nodes, edges = get_nodes_and_edges(DB_PATH)
        return jsonify({
            "nodes": nodes,
            "edges": edges
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/node/details", methods=["GET"])
def get_details():
    node_id = request.args.get("node_id")
    if not node_id:
        return jsonify({"error": "No node_id provided"}), 400
        
    try:
        node = get_node_by_id(node_id, DB_PATH)
        if not node:
            return jsonify({"error": "Node not found"}), 404
            
        # Get start/end byte from nodes list or read file by lines
        # Since we only stored start_row and end_row in SQLite, let's read file lines
        filepath = node["filepath"]
        start_row = node["start_row"]
        end_row = node["end_row"]
        
        code_snippet = ""
        if os.path.exists(filepath):
            with open(filepath, 'rb') as f:
                lines = f.readlines()
            # Extract lines (0-indexed)
            snippet_lines = lines[start_row:end_row + 1]
            code_snippet = b"".join(snippet_lines).decode('utf-8', errors='ignore')
            
        node["code"] = code_snippet
        return jsonify(node)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/node/explain", methods=["GET"])
def explain_node():
    node_id = request.args.get("node_id")
    if not node_id:
        return jsonify({"error": "No node_id provided"}), 400
        
    try:
        if node_id.startswith("library_entity:"):
            lib_name = node_id.split(":", 1)[1]
            prompt = (
                f"Explain what the Python library module or function '{lib_name}' does. "
                f"Keep it concise in 2-3 sentences for a developer new to this codebase."
            )
            import ollama
            response = ollama.chat(
                model='qwen2.5-coder:3b',
                messages=[{'role': 'user', 'content': prompt}],
                options={'temperature': 0.2}
            )
            explanation = response['message']['content'].strip()
            return jsonify({"explanation": explanation})

        node = get_node_by_id(node_id, DB_PATH)
        if not node:
            return jsonify({"error": "Node not found"}), 404
            
        filepath = node["filepath"]
        start_row = node["start_row"]
        end_row = node["end_row"]
        
        code_snippet = ""
        if os.path.exists(filepath):
            with open(filepath, 'rb') as f:
                lines = f.readlines()
            snippet_lines = lines[start_row:end_row + 1]
            code_snippet = b"".join(snippet_lines).decode('utf-8', errors='ignore')
            
        explanation = get_node_explanation(node["name"], code_snippet)
        return jsonify({"explanation": explanation})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/walkthrough", methods=["GET"])
def get_walkthrough():
    start_id = request.args.get("start_id")
    try:
        nodes, edges = get_nodes_and_edges(DB_PATH)
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
            entry_candidates.sort(key=lambda n: (n["name"] != 'main', n["name"] != 'cli', n["id"]))
            if not entry_candidates:
                min_deg = min(in_degrees.values())
                entry_candidates = [n for n in nodes if in_degrees[n["id"]] == min_deg]
                entry_candidates.sort(key=lambda n: (n["name"] != 'main', n["name"] != 'cli', n["id"]))
                
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
