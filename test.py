import tree_sitter_python as tspython
from tree_sitter import Language, Parser
from main import resolve_imports
import os

PY_LANGUAGE = Language(tspython.language())
parser = Parser(PY_LANGUAGE)

code = b"""
from traceback import print_tb
import time
from math import sqrt, root as r
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
"""

# def resolve_imports(code, root_dir):

print(resolve_imports(code, os.curdir))

tree = parser.parse(code)
root = tree.root_node

def find_all(node, indent=0):
    print(" " * indent + node.type)
    # print(node, str(node.start_point))
    for child in node.children:
        find_all(child, indent + 2)

find_all(root)