---
name: linear
description: Read a Linear issue's human-authored content — title, description, state, assignee, and comments — and post a comment back to an issue, by its identifier (e.g. ABC-123), using the Linear API with LINEAR_API_KEY. Use whenever you need to know what a Linear issue is actually asking for (triaging, understanding a bug report, checking discussion) or to write findings back onto an issue (grooming). Use this instead of any Linear MCP server, which needs interactive OAuth and fails in an unattended agent.
---

# Linear

Read Linear issue content — and post comments back — headlessly via the Linear GraphQL API.
Authenticates with `LINEAR_API_KEY` (a personal API key passed directly as the `Authorization`
header), so it works in an unattended agent — unlike the hosted Linear MCP, which requires an
interactive OAuth login.

## Fetch an issue

Run the bundled script with the issue identifier:

```bash
~/.claude/skills/linear/scripts/get-issue.sh <ISSUE_ID>     # e.g. ABC-123
```

It prints the issue's title, state, assignee, URL, description, and all comments — the human context
you need to understand what the issue requires. `LINEAR_API_KEY` is already set in h agents.

## Post a comment

Write findings, context, or a grooming write-up back onto an issue:

```bash
~/.claude/skills/linear/scripts/add-comment.sh <ISSUE_ID> <BODY_FILE>   # e.g. add-comment.sh ABC-123 findings.md
cat findings.md | ~/.claude/skills/linear/scripts/add-comment.sh <ISSUE_ID> -   # or from stdin
```

The comment body is read from a **file or stdin**, never a command-line argument — so multi-line
Markdown with quotes, backslashes, or `$` posts verbatim without shell-escaping problems. Write your
Markdown to a file first, then pass the path. The script resolves the human identifier to the issue's
UUID, posts the comment, and prints the new comment's URL. It refuses to post an empty body and exits
non-zero (with the API error) on failure.

## Notes

- The identifier is the human key shown in Linear (`<TEAM>-<NUMBER>`, e.g. `ABC-123`), not a UUID.
- Exit code is non-zero with a message on stderr if no issue matches the identifier.
- Do **not** reach for a Linear MCP server; it cannot authenticate headless. This script is the
  supported way to read Linear from an agent run.
