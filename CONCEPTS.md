# Concepts

## dapr-agents

`dapr-agents` is an agentic loop framework that uses the Dapr Actor model to serialise concurrent requests and make multi-step tool-calling turns durable and recoverable.

It manages two lifecycles:

- **Agent instance lifecycle** – via the Dapr Actor runtime (activate on first request, deactivate after idle timeout, state survives across both).
- **Turn lifecycle** – the multi-step tool-calling loop within a single user message, including crash recovery mid-loop.

### State

Two separate state stores are in play:

| Store | Component type | What it holds |
|---|---|---|
| `conversationstore` | `state.*` | Message history – the accumulated `{role, content}` turns prepended to each LLM call. Written by `ConversationDaprStateMemory` on the app side. |
| `statestore` | `state.*` (with `actorStateStore: true`) | Operational state of the agent mid-turn – current workflow step, pending tool calls, partial scratchpad. Written by the Dapr Actor runtime. |

Conversation state answers *"what has been said?"*. Actor state answers *"where are we in executing the current turn?"*. For a single-turn, no-tools agent only conversation state is needed; actor state becomes load-bearing as soon as a turn involves a multi-step tool-calling loop.

### Concurrency

The actor model serialises concurrent requests to the same agent instance – only one turn runs at a time. This is stronger than thread-safety: it is request serialisation at the actor boundary enforced by the Dapr runtime, not locks in application code.

### Dapr Conversation API

`DaprChatClient` routes LLM calls through the sidecar's Conversation API (`/v1.0-alpha1/conversation/{component}/converse`). The LLM provider, API key, base URL, and model are configured in a component YAML – not in application code. Swapping providers means adding a new component YAML and changing `component_name`.

The Conversation API is a **routing primitive**, not a stateful agent runtime. Memory and turn orchestration are the application's (or `dapr-agents'`) responsibility.

## Dynamic workflow composition

Workflows are defined as a list of steps sent in the request payload rather than hardcoded in source. Each step names a registered activity and supplies its input. The workflow executor iterates the steps, resolves cross-step references (via `$ref`), and injects the `workflowInstanceId` automatically.

This separates two concerns that are typically conflated:

- **Activities** – registered at startup; the fixed vocabulary of things the system can do (setup an agent workspace, invoke Claude, copy output, wait for input, …).
- **Workflow composition** – defined at call time; which activities to run, in what order, with what inputs.

Adding a new capability means adding an activity to the registry. The composition of those capabilities into a workflow is the caller's concern.

## Per-workflow workspace isolation

Each workflow instance gets its own working directory (`{AGENT_BASE_DIR}/workspaces/{workflowInstanceId}/`) on the agent service. Setup runs there — installed skills, config, and any files the agent creates are scoped to that instance. The agent is invoked with that directory as its working directory, so it only sees the skills and context prepared for that specific run.

`AGENT_BASE_DIR` points outside the h repo (`../h-workspace/<agent>`) so the agent's project root detection is anchored to the workspace, not the h repo root.

## Cross-step data flow

Each activity's return value is stored in a `results` map keyed by `step.id` after it completes. Subsequent steps can reference any prior result using two syntaxes resolved just before the step runs:

| Syntax | Behaviour |
|---|---|
| `"{{stepId.field}}"` | String interpolation – the reference is replaced inline within a string value |
| `{ "$ref": "stepId.field" }` | Whole-value replacement – passes the raw value (object, array, etc.) as the field |

Both use dot-separated paths to walk the `results` map, so nested fields are reachable (e.g. `build-api.output.summary`).

The resolution happens in the workflow executor immediately before each activity is invoked, so activities always receive fully-resolved inputs – they never see template syntax.

## Human-in-the-loop

A workflow can pause at any point and wait for user input using Dapr's external event mechanism. The workflow suspends at a `wait-for-input` step; an external caller resumes it by raising an event against the workflow instance (via `POST /workflow/{instanceId}/resume`). The user's response becomes the input to the next step — typically a follow-up `run-claude` step that resumes the same Claude session.

This makes human gates a first-class step in the workflow definition rather than special-cased logic. Whether a workflow needs human approval is expressed in the step list, not in application code.

Claude lifecycle events (tool use, stop) are published to a Dapr pub/sub topic via hooks, giving subscribers visibility into what Claude produced and whether a response is expected — the natural signal for surfacing a human-in-the-loop prompt to a UI or notification channel.
