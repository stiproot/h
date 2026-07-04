# Hostile-content fixture

This spec deliberately carries every token class that must survive rendering untouched.
It is the committed proof of the delimiter-coexistence story — if any layer (helm, YAML,
the JSON wire step) mangles one of these, the golden snapshot diff catches it.

- agent-side shell vars: $AGENT_APP_DIR and ${H_SKILLS_DIR}
- envsubst-style tokens: ${VARS} and ${NOT_A_REAL_VAR}
- engine-style tokens: {{step.field}} and {"$ref": "step.field"}
- "double quotes", 'single quotes', back\slashes, a lone $ sign
- markdown: `inline code`, **bold**, a [link](https://example.invalid)

  an indented block
    a deeper one

Trailing punctuation and unicode: café, emoji ✅, em-dash —
