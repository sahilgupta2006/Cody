import os
import re
import importlib
from dataclasses import dataclass
import tree_sitter_python as tspython
from tree_sitter import Language, Parser

# Initialize base Python parser
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

# Mapping of file extensions to their corresponding Tree-sitter modules
LANG_BINDINGS = {
    ".py": "tree_sitter_python",
    ".rs": "tree_sitter_rust",
    ".go": "tree_sitter_go",
    ".java": "tree_sitter_java",
    ".js": "tree_sitter_javascript",
    ".jsx": "tree_sitter_javascript",
    ".ts": "tree_sitter_typescript",
    ".tsx": "tree_sitter_typescript",
    ".cpp": "tree_sitter_cpp",
    ".hpp": "tree_sitter_cpp",
    ".h": "tree_sitter_cpp",
    ".cc": "tree_sitter_cpp",
    ".cs": "tree_sitter_c_sharp",
}

LANG_MAP = LANG_BINDINGS

# Node types configurations for AST symbol extraction
LANG_CONFIGS = {
    ".py": {
        "functions": {"function_definition"},
        "classes": {"class_definition"},
        "calls": {"call"},
        "func_field": "function",
        "member_fields": ["attribute"]
    },
    ".rs": {
        "functions": {"function_item"},
        "classes": {"struct_item", "enum_item", "impl_item", "trait_item"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["field"]
    },
    ".go": {
        "functions": {"function_declaration", "method_declaration"},
        "classes": {"type_declaration"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["field"]
    },
    ".java": {
        "functions": {"method_declaration"},
        "classes": {"class_declaration", "interface_declaration", "enum_declaration"},
        "calls": {"method_invocation"},
        "func_field": "name",
        "member_fields": []
    },
    ".js": {
        "functions": {"function_declaration", "method_definition", "generator_function_declaration"},
        "classes": {"class_declaration"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["property"]
    },
    ".jsx": {
        "functions": {"function_declaration", "method_definition", "generator_function_declaration"},
        "classes": {"class_declaration"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["property"]
    },
    ".ts": {
        "functions": {"function_declaration", "method_definition", "generator_function_declaration"},
        "classes": {"class_declaration", "interface_declaration"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["property"]
    },
    ".tsx": {
        "functions": {"function_declaration", "method_definition", "generator_function_declaration"},
        "classes": {"class_declaration", "interface_declaration"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["property"]
    },
    ".cpp": {
        "functions": {"function_definition"},
        "classes": {"class_specifier", "struct_specifier", "namespace_definition"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["field"]
    },
    ".hpp": {
        "functions": {"function_definition"},
        "classes": {"class_specifier", "struct_specifier", "namespace_definition"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["field"]
    },
    ".cc": {
        "functions": {"function_definition"},
        "classes": {"class_specifier", "struct_specifier", "namespace_definition"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["field"]
    },
    ".h": {
        "functions": {"function_definition"},
        "classes": {"class_specifier", "struct_specifier", "namespace_definition"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["field"]
    },
    ".cs": {
        "functions": {"method_declaration", "constructor_declaration"},
        "classes": {"class_declaration", "interface_declaration", "struct_declaration", "enum_declaration"},
        "calls": {"call_expression"},
        "func_field": "function",
        "member_fields": ["property"]
    }
}

# Cache of dynamically loaded Tree-sitter parsers
_parsers_cache = {}

def get_language_parser(ext):
    """
    Dynamically loads the Tree-sitter binding for the given extension and returns a Parser.
    """
    if ext in _parsers_cache:
        return _parsers_cache[ext]
        
    module_name = LANG_BINDINGS.get(ext)
    if not module_name:
        return None
        
    try:
        mod = importlib.import_module(module_name)
        lang = Language(mod.language())
        p = Parser(lang)
        _parsers_cache[ext] = p
        return p
    except Exception as e:
        print(f"[WARN] Failed to load tree-sitter parser for {ext}: {e}")
        return None

def get_identifier_text(node):
    """
    Recursively scans for the first identifier/type_identifier in the subtree.
    """
    if node.type in ["identifier", "type_identifier", "type_name"]:
        return node.text.decode('utf-8', errors='ignore')
    for child in node.children:
        res = get_identifier_text(child)
        if res:
            return res
    return None

def get_node_name(node):
    """
    Resolves the name of a function/class node in a language-agnostic way.
    """
    # 1. Try 'name' field
    name_node = node.child_by_field_name("name")
    if name_node:
        return name_node.text.decode('utf-8', errors='ignore')
        
    # 2. Try 'declarator' field
    decl_node = node.child_by_field_name("declarator")
    if decl_node:
        name = get_identifier_text(decl_node)
        if name:
            return name
            
    # 3. Fallback: Scan children directly
    name = get_identifier_text(node)
    if name:
        return name
        
    return "anonymous"

def get_last_identifier(node):
    """
    Finds the rightmost identifier (useful for member calls: x.y.z -> z).
    """
    if node.type in ["identifier", "type_identifier"]:
        return node.text.decode('utf-8', errors='ignore')
    for child in reversed(node.children):
        res = get_last_identifier(child)
        if res:
            return res
    return None

def extract_call_name(call_node, config):
    """
    Extracts the name of the function being called from a call node.
    """
    func_field = config["func_field"]
    func_node = call_node.child_by_field_name(func_field)
    
    if not func_node:
        # Special fallback for Java method invocation (uses name child or identifier child)
        if func_field == "name":
            for child in call_node.children:
                if child.type == "identifier":
                    return child.text.decode('utf-8', errors='ignore')
        return None
        
    if func_node.type in ["identifier", "type_identifier"]:
        return func_node.text.decode('utf-8', errors='ignore')
        
    # Handle member/attribute calls (like bytes.is_empty)
    for field_name in config["member_fields"]:
        prop_node = func_node.child_by_field_name(field_name)
        if prop_node:
            return prop_node.text.decode('utf-8', errors='ignore')
            
    # Rightmost fallback
    return get_last_identifier(func_node)

def get_parser():
    return parser

def find_block_end(lines, start_idx):
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
    Language-agnostic symbol parser fallback for non-python files.
    """
    ext = os.path.splitext(filepath)[1].lower()
    if ext not in LANG_BINDINGS:
        return []
        
    lines = code_str.splitlines()
    nodes = []
    
    if ext in [".js", ".jsx", ".ts", ".tsx"]:
        pat = re.compile(
            r'(?:class\s+([a-zA-Z0-9_$]+))|'
            r'(?:function\s+([a-zA-Z0-9_$]+))|'
            r'(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>|'
            r'^\s*(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{'
        )
    elif ext == ".go":
        pat = re.compile(r'func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_$]+)\s*\(')
    elif ext == ".rs":
        pat = re.compile(r'(?:fn\s+([a-zA-Z0-9_$]+)|impl(?:\s*<[^>]+>)?\s+([a-zA-Z0-9_$]+))')
    elif ext in [".java", ".cpp", ".hpp", ".cc", ".h", ".cs"]:
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
        
        if os.path.isfile(mod_path + ".py"):
            return mod_path + ".py", False
            
        if os.path.isdir(mod_path) and os.path.isfile(os.path.join(mod_path, "__init__.py")):
            return os.path.join(mod_path, "__init__.py"), True
            
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
