import subprocess
from pathlib import Path

from agent_core.workspace_paths import contained_path, safe_name
from langchain_core.tools import StructuredTool

DEFAULT_TOOL_NAMES = ["search_skills", "install_skill", "read_skill", "write_file"]


def make_tools(cwd: Path) -> dict[str, StructuredTool]:
    """Build the tool registry, with each tool bound to the run's workspace `cwd`."""

    def search_skills(query: str) -> str:
        """Search for available tessl skills matching the query."""
        result = subprocess.run(
            ["tessl", "search", query], capture_output=True, text=True, cwd=str(cwd)
        )
        return result.stdout or result.stderr

    def install_skill(package: str, skill_name: str) -> str:
        """Install a tessl skill from the given package."""
        result = subprocess.run(
            ["tessl", "install", package, "--skill", skill_name],
            capture_output=True,
            text=True,
            cwd=str(cwd),
        )
        if result.returncode != 0:
            return f"Error: {result.stderr}"
        return result.stdout or "Installed successfully."

    def read_skill(skill_name: str) -> str:
        """Read the SKILL.md for an installed tessl skill."""
        try:
            safe = safe_name(skill_name, kind="skill name")
        except ValueError as err:
            return f"Error: {err}"
        skill_path = cwd / ".tessl" / "skills" / safe / "SKILL.md"
        if not skill_path.exists():
            return f"Skill file not found: {skill_path}"
        return skill_path.read_text()

    def write_file(path: str, content: str) -> str:
        """Write content to a file in the workspace."""
        try:
            target = contained_path(cwd, path)
        except ValueError as err:
            return f"Error: {err}"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return f"Written: {target}"

    fns = [search_skills, install_skill, read_skill, write_file]
    return {fn.__name__: StructuredTool.from_function(fn) for fn in fns}


def resolve_tools(names: list[str] | None, cwd: Path) -> list[StructuredTool]:
    """Resolve the selected tool names to workspace-bound tools, defaulting to all."""
    registry = make_tools(cwd)
    selected = names or DEFAULT_TOOL_NAMES
    missing = [n for n in selected if n not in registry]
    if missing:
        available = ", ".join(registry)
        raise ValueError(f"Unknown tool(s): {', '.join(missing)}. Available: {available}")
    return [registry[n] for n in selected]
