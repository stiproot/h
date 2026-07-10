import math
from datetime import UTC, datetime

from claude_agent_sdk import tool

_SAFE_MATH = {
    "sqrt": math.sqrt,
    "abs": abs,
    "floor": math.floor,
    "ceil": math.ceil,
    "round": round,
    "pi": math.pi,
    "e": math.e,
    "pow": math.pow,
}


@tool(
    "calculator",
    "Evaluate a safe mathematical expression. "
    "Supports +, -, *, /, **, sqrt, abs, floor, ceil, round, pi, e.",
    {"expression": str},
)
async def calculator(args):
    try:
        result = eval(args["expression"], {"__builtins__": {}}, _SAFE_MATH)  # noqa: S307
        return {"content": [{"type": "text", "text": str(result)}]}
    except Exception as exc:
        return {"content": [{"type": "text", "text": f"Error: {exc}"}]}


@tool("word_count", "Count words, characters, and lines in text.", {"text": str})
async def word_count(args):
    text = args["text"]
    lines = len(text.splitlines()) or 1
    result = f"Words: {len(text.split())}, Characters: {len(text)}, Lines: {lines}"
    return {"content": [{"type": "text", "text": result}]}


@tool("get_datetime", "Return the current UTC date and time.", {})
async def get_datetime(args):
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    return {"content": [{"type": "text", "text": now}]}


@tool(
    "format_text",
    "Transform text casing. format must be one of: upper, lower, title, snake, reverse.",
    {"text": str, "format": str},
)
async def format_text(args):
    text, fmt = args["text"], args["format"]
    match fmt:
        case "upper":
            result = text.upper()
        case "lower":
            result = text.lower()
        case "title":
            result = text.title()
        case "snake":
            result = "_".join(text.split()).lower()
        case "reverse":
            result = text[::-1]
        case _:
            result = f"Unknown format: {fmt}"
    return {"content": [{"type": "text", "text": result}]}


tools = [calculator, word_count, get_datetime, format_text]
