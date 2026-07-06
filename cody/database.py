import os
import sqlite3

def init_db(db_path="cody.db"):
    db_path = os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT,
        hierarchical_name TEXT,
        type TEXT,
        start_row INTEGER,
        end_row INTEGER,
        filepath TEXT
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS edges (
        from_node TEXT,
        to_node TEXT,
        type TEXT
    )
    """)
    
    conn.commit()
    conn.close()

def save_to_db(nodes, edges, db_path="cody.db"):
    db_path = os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')
    if os.path.exists(db_path):
        try:
            os.remove(db_path)
        except Exception as e:
            print(f"Error removing old db {db_path}: {e}")
            
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Re-initialize tables
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT,
        hierarchical_name TEXT,
        type TEXT,
        start_row INTEGER,
        end_row INTEGER,
        filepath TEXT
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS edges (
        from_node TEXT,
        to_node TEXT,
        type TEXT
    )
    """)
    
    for node in nodes:
        cursor.execute(
            "INSERT OR REPLACE INTO nodes (id, name, hierarchical_name, type, start_row, end_row, filepath) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (node.id, node.name, node.hierarchical_name, node.type, node.start[0], node.end[0], node.filepath)
        )
        
    for from_node, to_list in edges.items():
        for to_node, edge_type in to_list:
            cursor.execute(
                "INSERT INTO edges (from_node, to_node, type) VALUES (?, ?, ?)",
                (from_node, to_node, edge_type)
            )
            
    conn.commit()
    conn.close()
    print(f"[OK] Database saved: {db_path}")

def get_nodes_and_edges(db_path="cody.db"):
    db_path = os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')
    if not os.path.exists(db_path):
        return [], []
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Read nodes
    cursor.execute("SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes")
    node_rows = cursor.fetchall()
    nodes = []
    for r in node_rows:
        nodes.append({
            "id": r[0],
            "name": r[1],
            "hierarchical_name": r[2],
            "type": r[3],
            "start_row": r[4],
            "end_row": r[5],
            "filepath": r[6]
        })
        
    # Read edges
    cursor.execute("SELECT from_node, to_node, type FROM edges")
    edge_rows = cursor.fetchall()
    edges = []
    for r in edge_rows:
        edges.append({
            "from": r[0],
            "to": r[1],
            "type": r[2]
        })
        
    conn.close()
    return nodes, edges

def get_node_by_id(node_id, db_path="cody.db"):
    db_path = os.path.normpath(os.path.abspath(db_path)).replace('\\', '/')
    if not os.path.exists(db_path):
        return None
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT id, name, hierarchical_name, type, start_row, end_row, filepath FROM nodes WHERE id = ?", (node_id,))
    r = cursor.fetchone()
    conn.close()
    
    if r:
        return {
            "id": r[0],
            "name": r[1],
            "hierarchical_name": r[2],
            "type": r[3],
            "start_row": r[4],
            "end_row": r[5],
            "filepath": r[6]
        }
    return None
