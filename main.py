from traceback import print_tb
import time
from numpy.ma import default_fill_value
import queue
import subprocess
# from github import Github
import subprocess
import os

from dataclasses import dataclass
from collections import deque, defaultdict

import tree_sitter_python as tspython 
from tree_sitter import Language, Parser

PY_LANGUAGE = Language(tspython.language())
parser = Parser(PY_LANGUAGE)

@dataclass
class Node:
    id: str
    name: str
    hierarchical_name: str
    type: str
    start: tuple
    end: tuple
    indeg: int
    filepath: str

@dataclass
class Edge:
    id: str
    name: str
    from_node: str
    to_node: str
    start: tuple
    end: tuple

def resolve_imports(code, root_dir):
    root = parser.parse(code).root_node
    name_loc = defaultdict(list)

    def build_full_path(base_dir, dot_path):
        parts = dot_path.split(".")
        raw_path = os.path.join(base_dir, *parts)
        return os.path.abspath(raw_path)

    def traverse(node):
        if node.type == "import_from_statement":
            module_name = ""
            is_from_part = True
            
            for child in node.children:
                if child.type == "import":
                    is_from_part = False
                    
                elif child.type == "dotted_name" and is_from_part:
                    module_name = child.text.decode('utf-8')
                    
                elif child.type == "dotted_name" and not is_from_part:
                    actual = child.text.decode('utf-8')
                    filepath = build_full_path(root_dir, module_name)
                    if os.path.exists(filepath):
                        name_loc[aliased].append({"actual_name": actual, "filepath": filepath})
                    
                elif child.type == "aliased_import":
                    actual = child.children[0].text.decode('utf-8')
                    aliased = child.children[2].text.decode('utf-8')
                    filepath = build_full_path(root_dir, module_name)

                    if os.path.exists(filepath):
                        name_loc[aliased].append({"actual_name": actual, "filepath": filepath})

        elif node.type == "import_statement":
            for child in node.children:
                if child.type == "dotted_name":
                    module_name = child.text.decode('utf-8')
                    filepath = build_full_path(root_dir, module_name)
                    if os.path.exists(filepath):
                        name_loc[module_name].append({"actual_name": module_name, "filepath": filepath})
                    
                elif child.type == "aliased_import":
                    actual = child.children[0].text.decode('utf-8')
                    aliased = child.children[2].text.decode('utf-8')
                    filepath = build_full_path(root_dir, actual)
                    if os.path.exists(filepath):
                        name_loc[aliased].append({"actual_name": actual, "filepath": filepath})

        for child in node.children:
            traverse(child)

    traverse(root)
    return name_loc

def clone_repo(url, target_dir="cloned_repo"):
    if os.path.exists(target_dir):
        print("Repo already cloned!")
        return target_dir

    subprocess.run(["git", "clone", url, target_dir], check=True)
    return target_dir

def make_nodes(repo_dir="cloned_repo"):
    if not os.path.exists(repo_dir):
        print("Repo not available!")
        return [], defaultdict(list), dict()

    possible_nodes = [] # i will store functions and classes here (probable entities)
    name_node = defaultdict(list)
    nodes_table = dict()
    visited = set() # to store visited functions and classes
    
    for root_dir, dirs, files in os.walk(repo_dir):
        for file in files:
            if file.endswith(".py"):
                filename = os.path.join(root_dir, file)

                with open(filename, "rb") as f:
                    code = f.read()
                
                tree = parser.parse(code)
                root = tree.root_node

                q = deque()
                q.append((root, "__start_of_the_code_space_Cody_Term__"))


                while(len(q)):
                    r, parent = q.popleft()

                    if r.type == "function_definition" or r.type == "class_definition":
                        sp = r.start_point
                        ep = r.end_point
                        name = r.child_by_field_name("name").text.decode()
                        type = r.type
                        filepath = filename

                        hierarchical_name = parent

                        id = f"{filename}:{hierarchical_name+":"+name}:{sp[0]}:{sp[1]}:{ep[0]}:{ep[1]}"
                        name_node[name].append({"id": id, "hierarchical_name": f"{filename}:{hierarchical_name}"})

                        if id not in visited:
                            n = Node(id, 
                                        name,
                                        hierarchical_name,
                                        type,
                                        sp,
                                        ep,
                                        0,
                                        filepath)
                            possible_nodes.append(n)
                            visited.add(id)
                            nodes_table[id] = n

                        parent = hierarchical_name + ":" + name

                    for child in r.children:
                        q.append((child, parent))

    return possible_nodes, name_node, nodes_table


def make_edges(name_node, repo_dir="cloned_repo"):
    if not os.path.exists(repo_dir):
        print("Repo doesnt exist!")
        return []

    possible_nodes = []
    adj_list = defaultdict(list)
    visited = set()

    for root_dir, dirs, files in os.walk(repo_dir):
        for file in files:
            if file.endswith(".py"):
                filename = os.path.join(root_dir, file)
                with open(filename, "rb") as f:
                    code = f.read()

                tree = parser.parse(code)
                root = tree.root_node

                q = deque()
                q.append((root, "__start_of_the_code_space_Cody_Term__"))

                while len(q):
                    r, parent = q.popleft()

                    if r.type == "function_definition" or r.type == "class_definition":
                        sp = r.start_point
                        ep = r.end_point
                        name = r.child_by_field_name("name").text.decode()
                        hierarchical_name = parent
                        id = f"{filename}:{hierarchical_name+":"+name}:{sp[0]}:{sp[1]}:{ep[0]}:{ep[1]}"

                        if id not in visited:
                                possible_nodes.append(Node(id, 
                                                                name,
                                                                hierarchical_name,
                                                                type,
                                                                sp,
                                                                ep,
                                                                0))
                                visited.add(id)

                        parent = hierarchical_name+":"+name

                    elif r.type == "call":
                        from_node = parent
                        func_node = r.child_by_field_name("function")
                        if func_node.type == "identifier":
                            to_node = func_node.text.decode()
                        elif func_node.type == "attribute":
                            to_node = func_node.child_by_field_name("attribute").text.decode()
                        
                        if len(name_node[to_node]) == 1:
                            adj_list[from_node].append(name_node[to_node][0]["id"])
                        elif len(name_node[to_node]) > 1:
                            adj_list[from_node].append(name_node[to_node][0]["id"])
                            # to solve this.
                        else:
                            adj_list[from_node].append(f"library_entity:{to_node}")
                    
                    for child in r.children:
                                q.append((child, parent))
    return adj_list

if __name__ == "__main__":
    clone_repo("https://github.com/sahilgupta2006/netsec")

    nodes, name_node, nodes_table = make_nodes("cloned_repo")
    adj_list = make_edges(name_node, "cloned_repo")

    for node in nodes:
        print(node)

    print("")
    print("edges:")
    for from_node, to_nodes in adj_list.items():
        internal = [t for t in to_nodes if isinstance(t, str)]
        if internal:
            print(f"\n{from_node}")
            for to in internal:
                print(f"    --> {to}")

    # print("Cody Walkthrough:")

    def entryPoints(nodes, adj_list):
        all_nodes = set(n.id for n in nodes)
        called = set()

        for from_n, to_n in adj_list.items():
            for to in to_n:
                if not to.startswith("library_entity:"):
                    called.add(to)

        return all_nodes - called


    entries = entryPoints(nodes, adj_list)

    print(len(entries))

    def bfs(node, adj_list):
        q = deque()
        q.append(node)

        visited = set()
        visited.add(node)

        while (len(q)):
            e = q.popleft()
            print("Currently At: ", e)
            time.sleep(1)

            for child in adj_list[e]:
                if not child.startswith("library_entity") and child not in visited:
                    q.append(child)
                    visited.add(child)

    print("Cody Walkthrough:")

    for e in entries:
        print("Walkthrough starting from: ", e)
    # bfs("cloned_repo\main.py:cloned_repo\main.py:__start_of_the_code_space_Cody_Term__:main:26:0:179:17", adj_list)
    # bfs("cloned_repo\main.py:__start_of_the_code_space_Cody_Term__:main:26:0:179:17", adj_list)

