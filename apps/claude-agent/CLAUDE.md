# Agent workspace rules

- All files and directories must be created relative to the current working directory. Never write to absolute paths outside it.
- Do not read from or reference files outside the current working directory.

## Code review output format

When asked to write a code review to a file, produce a Markdown file with these sections:

```
## Summary
One-paragraph assessment of the code.

## Issues Found
Bulleted list. Each entry: what the issue is and why it matters.

## Recommendations
Bulleted list of concrete improvements. Most impactful first.
```
