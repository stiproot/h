import subprocess
from pathlib import Path

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "search_skills",
            "description": "Search for available tessl skills matching the query.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "install_skill",
            "description": "Install a tessl skill from the given package.",
            "parameters": {
                "type": "object",
                "properties": {
                    "package": {"type": "string"},
                    "skill_name": {"type": "string"},
                },
                "required": ["package", "skill_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_skill",
            "description": "Read the SKILL.md for an installed tessl skill.",
            "parameters": {
                "type": "object",
                "properties": {"skill_name": {"type": "string"}},
                "required": ["skill_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
]


def make_tool_fns(cwd: Path) -> dict:
    def search_skills(query: str) -> str:
        result = subprocess.run(
            ["tessl", "search", query], capture_output=True, text=True, cwd=str(cwd)
        )
        return result.stdout or result.stderr

    def install_skill(package: str, skill_name: str) -> str:
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
        skill_path = cwd / ".tessl" / "skills" / skill_name / "SKILL.md"
        if not skill_path.exists():
            return f"Skill file not found: {skill_path}"
        return skill_path.read_text()

    def write_file(path: str, content: str) -> str:
        target = cwd / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return f"Written: {target}"

    return {
        "search_skills": search_skills,
        "install_skill": install_skill,
        "read_skill": read_skill,
        "write_file": write_file,
    }
