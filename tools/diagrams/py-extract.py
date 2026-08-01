#!/usr/bin/env python3
"""Python AST extraction — the Python sibling of ts-extract.mjs (see tools/diagrams/README.md).

argv[1] is a JSON request {file?, source?, kind, symbol?, functions?, consts?}; stdout is a
JSON response {lines, stereotype?}. `source` (inline text) wins over `file` so the unit tests
stay filesystem-free, mirroring ts-extract's fromSource entry. Members are extracted with the
stdlib `ast` module so generated class diagrams stay code truth for the Python stack too;
scope/topology/notes remain curated in the doc manifest, exactly like the TypeScript side.

Kinds:
  class  — a ClassDef's annotated fields, public methods, and @property members; dataclass
           decoration (frozen or not) becomes the default stereotype.
  module — the listed module-level `functions` (+ optional `consts`) as signature lines.

Type sanitising mirrors sanitize.mjs, translated to Python syntax: whitespace collapses;
Callable reads as `fn`; a subscript keeps the outer name + FIRST argument only
(`dict[str, int]` -> `dict~str~`) because mermaid member lines cannot carry commas safely;
string-literal (forward-ref) annotations unquote. Line CAPPING stays JS-side (capLine) so the
72-char rule has one home.

A missing symbol exits non-zero with a message — fail loud, never a silent empty class.
"""

from __future__ import annotations

import ast
import json
import sys
from typing import Any


def short_type(node: ast.AST | None) -> str:
    """Annotation AST -> mermaid-safe member type text (the sanitize.mjs rules, Python syntax)."""
    if node is None:
        return ""
    if isinstance(node, ast.Constant):  # forward-ref string or None
        return "None" if node.value is None else str(node.value)
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return f"{short_type(node.left)} | {short_type(node.right)}"
    if isinstance(node, ast.Subscript):
        outer = short_type(node.value)
        if outer == "Callable":
            return "fn"
        first = node.slice.elts[0] if isinstance(node.slice, ast.Tuple) and node.slice.elts else node.slice
        return f"{outer}~{short_type(first)}~"
    return " ".join(ast.unparse(node).split())


def _params(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    names = [a.arg for a in (*fn.args.posonlyargs, *fn.args.args) if a.arg not in ("self", "cls")]
    if fn.args.vararg:
        names.append("*" + fn.args.vararg.arg)
    names.extend(a.arg for a in fn.args.kwonlyargs)
    return ", ".join(names)


def _sig_line(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    ret = short_type(fn.returns)
    return f"+{fn.name}({_params(fn)})" + (f" {ret}" if ret else "")


def _is_property(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    return any(isinstance(d, ast.Name) and d.id == "property" for d in fn.decorator_list)


def _dataclass_stereotype(cls: ast.ClassDef) -> str:
    for dec in cls.decorator_list:
        target = dec.func if isinstance(dec, ast.Call) else dec
        name = target.attr if isinstance(target, ast.Attribute) else getattr(target, "id", None)
        if name == "dataclass":
            frozen = isinstance(dec, ast.Call) and any(
                kw.arg == "frozen" and isinstance(kw.value, ast.Constant) and kw.value.value is True
                for kw in dec.keywords
            )
            return "frozen dataclass" if frozen else "dataclass"
    return "class"


def _const_line(name: str, stmt: ast.stmt) -> str:
    if isinstance(stmt, ast.AnnAssign):
        return f"+{name} {short_type(stmt.annotation)}"
    value = stmt.value if isinstance(stmt, ast.Assign) else None
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return f"+{name} ({value.value})"
    return f"+{name}"


def _find_const(tree: ast.Module, name: str, where: str) -> ast.stmt:
    for stmt in tree.body:
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.target.id == name:
            return stmt
        if isinstance(stmt, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in stmt.targets
        ):
            return stmt
    sys.exit(f"{where}: const {name} not found")


def extract(request: dict[str, Any]) -> dict[str, Any]:
    where = request.get("file", "<source>")
    source = request.get("source")
    if source is None:
        with open(request["file"], encoding="utf-8") as f:
            source = f.read()
    tree = ast.parse(source)
    kind = request["kind"]

    if kind == "class":
        symbol = request["symbol"]
        cls = next(
            (s for s in tree.body if isinstance(s, ast.ClassDef) and s.name == symbol), None
        )
        if cls is None:
            sys.exit(f"{where}: class {symbol} not found")
        lines: list[str] = []
        for stmt in cls.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                if stmt.target.id.startswith("_"):
                    continue
                lines.append(f"+{stmt.target.id} {short_type(stmt.annotation)}")
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if stmt.name.startswith("_"):
                    continue
                if _is_property(stmt):
                    ret = short_type(stmt.returns)
                    lines.append(f"+{stmt.name}" + (f" {ret}" if ret else ""))
                else:
                    lines.append(_sig_line(stmt))
        return {"lines": lines, "stereotype": _dataclass_stereotype(cls)}

    if kind == "module":
        lines = [_const_line(name, _find_const(tree, name, where)) for name in request.get("consts", [])]
        for name in request.get("functions", []):
            fn = next(
                (
                    s
                    for s in tree.body
                    if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)) and s.name == name
                ),
                None,
            )
            if fn is None:
                sys.exit(f"{where}: function {name} not found")
            lines.append(_sig_line(fn))
        module_name = str(where).rsplit("/", 1)[-1]
        return {"lines": lines, "stereotype": f"module {module_name}"}

    sys.exit(f"unknown kind '{kind}' for {request.get('id', where)}")


if __name__ == "__main__":
    print(json.dumps(extract(json.loads(sys.argv[1]))))
