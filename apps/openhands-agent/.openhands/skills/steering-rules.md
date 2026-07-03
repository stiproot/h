---
name: repo
type: repo
version: 1.0.0
agent: CodeActAgent
---

# Agent workspace rules

- All files and directories must be created relative to the current working directory. Never write to absolute paths outside it.
- Do not read from or reference files outside the current working directory.
