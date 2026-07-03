---
description: Inspect a Zipkin trace by id, or search recent traces
argument-hint: "<traceId | search terms>"
---

If `$ARGUMENTS` looks like a hex trace id, call the `obs` MCP `trace_get` and render the span tree
(service, span name, duration, errors).

Otherwise treat `$ARGUMENTS` as search terms and call `obs` `trace_search` (set `service` and/or
`name` — note a workflowInstanceId is often usable as a span `name`). List matching traces: traceId,
services involved, span names, duration, and whether any span errored.
