import subprocess
from pathlib import Path

from agent_core.workspace_paths import contained_path, safe_name

TOOL_SCHEMAS = [
    {
        "name": "search_skills",
        "description": "Search for available tessl skills matching the query.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search terms, e.g. 'node api' or 'hexagonal architecture'",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "install_skill",
        "description": "Install a tessl skill from the given package.",
        "input_schema": {
            "type": "object",
            "properties": {
                "package": {
                    "type": "string",
                    "description": "Package name, e.g. 'your-org/hex-node-service'",
                },
                "skill_name": {"type": "string", "description": "Skill name within the package"},
            },
            "required": ["package", "skill_name"],
        },
    },
    {
        "name": "read_skill",
        "description": "Read the SKILL.md for an installed tessl skill.",
        "input_schema": {
            "type": "object",
            "properties": {
                "skill_name": {"type": "string", "description": "Name of the installed skill"},
            },
            "required": ["skill_name"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file in the workspace.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path within the workspace"},
                "content": {"type": "string", "description": "File content"},
            },
            "required": ["path", "content"],
        },
    },
]


def execute_tool(name: str, args: dict, cwd: Path) -> str:
    if name == "search_skills":
        result = subprocess.run(
            ["tessl", "search", args["query"]],
            capture_output=True, text=True, cwd=str(cwd),
        )
        return result.stdout or result.stderr

    if name == "install_skill":
        result = subprocess.run(
            ["tessl", "install", args["package"], "--skill", args["skill_name"]],
            capture_output=True, text=True, cwd=str(cwd),
        )
        if result.returncode != 0:
            return f"Error: {result.stderr}"
        return result.stdout or "Installed successfully."

    # read_skill / write_file take a MODEL-supplied path segment. `cwd / arg` is not containment —
    # an absolute value or `..` walks straight out (see agent_core.workspace_paths).
    if name == "read_skill":
        try:
            safe = safe_name(args["skill_name"], kind="skill name")
        except ValueError as err:
            return f"Error: {err}"
        skill_path = cwd / ".tessl" / "skills" / safe / "SKILL.md"
        if not skill_path.exists():
            return f"Skill file not found: {skill_path}"
        return skill_path.read_text()

    if name == "write_file":
        try:
            target = contained_path(cwd, args["path"])
        except ValueError as err:
            return f"Error: {err}"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(args["content"])
        return f"Written: {target}"

    return f"Unknown tool: {name}"
