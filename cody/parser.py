import os
import re
from dataclasses import dataclass
import tree_sitter_python as tspython
from tree_sitter import Language, Parser

# Initialize Tree-sitter language and parser
PY_LANGUAGE = Language(tspython.language())
parser = Parser(PY_LANGUAGE)

@dataclass
class Node:
    id: str
    name: str
    hierarchical_name: str
    type: str
    start: tuple  # (start_row, start_col)
    end: tuple    # (end_row, end_col)
    indeg: int
    filepath: str
    start_byte: int = 0
    end_byte: int = 0

def get_parser():
    return parser

# File extensions mapping to language names
LANG_MAP = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".h": "cpp",
    ".cc": "cpp",
    ".cs": "csharp",
}

def find_block_end(lines, start_idx):
    """
    Brace-counting boundary scanner to locate curly brace function block ends.
    """
    brace_count = 0
    started = False
    for idx in range(start_idx, len(lines)):
        line = lines[idx]
        if '{' in line:
            brace_count += line.count('{')
            started = True
        if '}' in line:
            brace_count -= line.count('}')
            started = True
        if started and brace_count <= 0:
            return idx
    return len(lines) - 1

def parse_regex_symbols(filepath, code_str):
    """
    Language-agnostic symbol parser for non-python files.
    Extracts function and class definitions.
    """
    ext = os.path.splitext(filepath)[1].lower()
    if ext not in LANG_MAP:
        return []
        
    lines = code_str.splitlines()
    nodes = []
    
    # Select regex patterns based on file extension
    if ext in [".js", ".jsx", ".ts", ".tsx"]:
        # JS/TS: class, function, arrow const, or class method definitions
        pat = re.compile(
            r'(?:class\s+([a-zA-Z0-9_$]+))|'
            r'(?:function\s+([a-zA-Z0-9_$]+))|'
            r'(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>|'
            r'^\s*(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{'
        )
    elif ext == ".go":
        # Go: func and receiver methods
        pat = re.compile(r'func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_$]+)\s*\(')
    elif ext == ".rs":
        # Rust: fn or impl blocks
        pat = re.compile(r'(?:fn\s+([a-zA-Z0-9_$]+)|impl(?:\s*<[^>]+>)?\s+([a-zA-Z0-9_$]+))')
    elif ext in [".java", ".cpp", ".hpp", ".cc", ".h", ".cs"]:
        # C++/Java/C#: class names and typical method signatures
        pat = re.compile(
            r'(?:class\s+([a-zA-Z0-9_$]+))|'
            r'(?:(?:public|private|protected|static|virtual|override|async|\s)+\s+([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\{)'
        )
    else:
        return []
        
    for idx, line in enumerate(lines):
        m = pat.search(line)
        if m:
            name = None
            node_type = "function_definition"
            
            matched_groups = [g for g in m.groups() if g]
            if not matched_groups:
                continue
            name = matched_groups[0]
            
            if "class " in line or "impl " in line:
                node_type = "class_definition"
                
            start_row = idx
            end_row = find_block_end(lines, idx)
            parent = "__start_of_the_code_space_Cody_Term__"
            
            nodes.append({
                "name": name,
                "type": node_type,
                "parent": parent,
                "start": (start_row, 0),
                "end": (end_row, len(lines[end_row]) if end_row < len(lines) else 0),
                "start_byte": 0,
                "end_byte": 0
            })
            
    return nodes

def resolve_imports_for_file(filepath, code, repo_dir):
    """
    Parses code for import statements and resolves local imports relative to repo_dir.
    Returns: name_loc dict: imported_alias -> {"actual_name": actual_name, "filepath": resolved_filepath}
    """
    root_node = parser.parse(code).root_node
    name_loc = {}
    
    filepath = os.path.normpath(filepath).replace('\\', '/')
    repo_dir = os.path.normpath(repo_dir).replace('\\', '/')
    file_dir = os.path.dirname(filepath)
    
    def normalize_path(p):
        return os.path.normpath(p).replace('\\', '/')
        
    def find_module(base_dir, module_str, level):
        if level > 0:
            curr = file_dir
            for _ in range(level - 1):
                curr = os.path.dirname(curr)
            search_base = curr
        else:
            search_base = repo_dir
            
        search_base = normalize_path(search_base)
        
        if not module_str:
            return search_base, True
            
        parts = module_str.split('.')
        mod_path = normalize_path(os.path.join(search_base, *parts))
        
        # Check if it's a file
        if os.path.isfile(mod_path + ".py"):
            return mod_path + ".py", False
            
        # Check if it's a directory package
        if os.path.isdir(mod_path) and os.path.isfile(os.path.join(mod_path, "__init__.py")):
            return os.path.join(mod_path, "__init__.py"), True
            
        # Fallback for absolute imports relative to file_dir
        if level == 0 and search_base != file_dir:
            fallback_base = file_dir
            mod_path_fb = normalize_path(os.path.join(fallback_base, *parts))
            if os.path.isfile(mod_path_fb + ".py"):
                return mod_path_fb + ".py", False
            if os.path.isdir(mod_path_fb) and os.path.isfile(os.path.join(mod_path_fb, "__init__.py")):
                return os.path.join(mod_path_fb, "__init__.py"), True
                
        return None, False

    def traverse(node):
        if node.type == "import_from_statement":
            module_str = ""
            level = 0
            
            for child in node.children:
                if child.type == "import":
                    break
                elif child.type == "relative_import":
                    for subchild in child.children:
                        if subchild.type == "import_prefix":
                            level = subchild.text.decode('utf-8').count('.')
                        elif subchild.type == "dotted_name":
                            module_str = subchild.text.decode('utf-8')
                elif child.type == "dotted_name":
                    module_str = child.text.decode('utf-8')
                    level = 0
                    
            imports = []
            is_after_import = False
            for child in node.children:
                if child.type == "import":
                    is_after_import = True
                    continue
                if not is_after_import:
                    continue
                if child.type == "dotted_name":
                    actual = child.text.decode('utf-8')
                    imports.append({"actual_name": actual, "alias": actual})
                elif child.type == "aliased_import":
                    actual = child.children[0].text.decode('utf-8')
                    alias = child.children[2].text.decode('utf-8')
                    imports.append({"actual_name": actual, "alias": alias})
                    
            resolved_mod, is_package = find_module(file_dir, module_str, level)
            if resolved_mod:
                for imp in imports:
                    actual = imp["actual_name"]
                    alias = imp["alias"]
                    if is_package:
                        package_dir = os.path.dirname(resolved_mod)
                        sub_file = normalize_path(os.path.join(package_dir, actual + ".py"))
                        if os.path.isfile(sub_file):
                            name_loc[alias] = {"actual_name": actual, "filepath": sub_file}
                        else:
                            name_loc[alias] = {"actual_name": actual, "filepath": resolved_mod}
                    else:
                        name_loc[alias] = {"actual_name": actual, "filepath": resolved_mod}
                        
        elif node.type == "import_statement":
            imports = []
            for child in node.children:
                if child.type == "dotted_name":
                    actual = child.text.decode('utf-8')
                    imports.append({"actual_name": actual, "alias": actual})
                elif child.type == "aliased_import":
                    actual = child.children[0].text.decode('utf-8')
                    alias = child.children[2].text.decode('utf-8')
                    imports.append({"actual_name": actual, "alias": alias})
                    
            for imp in imports:
                actual = imp["actual_name"]
                alias = imp["alias"]
                resolved_mod, is_package = find_module(repo_dir, actual, 0)
                if resolved_mod:
                    name_loc[alias] = {"actual_name": actual, "filepath": resolved_mod}
                    
        for child in node.children:
            traverse(child)
            
    traverse(root_node)
    return name_loc
