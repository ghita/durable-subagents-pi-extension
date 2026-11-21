# Pi Durable Subagents

A Pi extension for named, reusable background agents backed by `@earendil-works/pi-durable`. Each agent has its own durable conversation. `/agents` provides deterministic human control, and the `subagent` tool lets Pi delegate ordinary user requests through the same management service.

## Requirements

- Pi `1.5.2` or compatible.
- A persisted Pi session transcript. Temporary or transcript-less sessions cannot use durable agents.
- A model available through Pi's configured Copilot login. The extension reuses Pi's `ModelRegistry`; it does not ask for or store a second credential.

Load this package with Pi's extension/package mechanism, or for local development:

```sh
pi --extension ./src/index.ts
```

Run checks with `npm test` and `npm run typecheck`. `npm run test:copilot` makes a real Copilot-authenticated model request; it requires a working Pi Copilot login and is not part of the offline test suite. Set `PI_DURABLE_COPILOT_MODEL` to choose another model.

## Commands

```text
/agents help
/agents presets
/agents list
/agents status <name>
/agents spawn <name> [--preset <preset-id>] -- <task>
/agents send <name> <message>
/agents stop <name>
/agents stop --all
/agents stats
/agents footer alwaysOn|activity
```

Names containing spaces can be quoted. If a spawn name matches a preset ID, that preset is used by default; `--preset` can select a different preset while retaining the chosen instance name. A missing preset is an unconfigured, all-tools agent. Name collisions—including with idle agents—receive a numeric suffix. Agents remain registered after completing or stopping work, and later `send` operations reuse their conversation. A send to busy work is steered into the existing agent. `stop --all` affects managed work only, never the main Pi agent.

The `subagent` tool supports `spawn`, `send`, `list`, `status`, `stop`, `stop-all`, and `stats`. It shares the same registry, presets, history, and service as `/agents`.

## Herdr live agent panes

When the extension runs in a Herdr-managed pane, each newly spawned agent gets its own non-focused split pane in the current Herdr tab. The first agent splits to the right of the main pane; each additional agent splits below the last agent within that right-side area. This preserves the main pane's width while stacking agents in rows instead of creating more thin columns, and the right-side rows are resized to equal heights as agents are added. Each pane is associated with its durable agent, so sending more work reuses it; the association is persisted with the managed-agent registry and restored when the Pi session resumes. Panes remain open after an agent finishes.

Each pane gets an identity header with the agent name, configured model, and thinking level. Thereafter the terminal is append-only: full user inputs, every assistant text message (not thinking content), and completed tool calls with the tool name, compact arguments (up to 500 characters), and finished/failed status. Tool results are not copied. Changes to an inherited model or thinking level are appended as configuration lines; the original header is not rewritten. Existing panes resume without replaying old transcript entries; on the first update after this change, the new identity header is appended once and its format version is persisted. Newly created panes start with a header and currently visible entries. Concurrent agents append to separate panes. Each pane uses a persistent renderer over a private local socket, so the Node bootstrap command is run once per pane rather than echoed for every transcript update. Existing managed-agent panes are reflowed into an equally sized right-side stack in the current tab when the session resumes; a pane closed during a session is recreated on the next agent update. The integration is enabled only when `HERDR_ENV=1` and `HERDR_WORKSPACE_ID` are present and the `herdr` CLI is available; failures are logged and do not stop agent work.

## Logging

Operational exceptions caught by the extension at failure-handling boundaries are appended as readable text to `<Pi agent directory>/logs/durable-subagents.log` (by default `~/.pi/agent/logs/durable-subagents.log`). The file is shared across Pi sessions. Entries include a timestamp, component/event label, and exception details/stack trace. Set `PI_DURABLE_SUBAGENTS_LOG_LEVEL=debug` before starting Pi to also log selected runtime, agent-action, and report-delivery lifecycle events; unset or other values keep exception-only logging. Expected recovery/fallback errors are not necessarily logged, and the extension does not install process-wide exception handlers. Logging is best effort; a log-write failure falls back to `console.error`. Task messages, prompts, and reports are not intentionally logged.

PowerShell:

```powershell
$env:PI_DURABLE_SUBAGENTS_LOG_LEVEL = "debug"
pi
```

Bash:

```sh
PI_DURABLE_SUBAGENTS_LOG_LEVEL=debug pi
```

## Presets

Presets are user-global at:

```text
<Pi configured agent directory>/agents/<preset-id>/agent.md
```

The base directory comes from Pi's `getAgentDir()` configuration. Example:

```md
---
tools: [read, bash]
model: github-copilot/<model-id>
thinking: high
---

Search the project and return a concise summary with file references.
```

`tools`, `model`, and `thinking` are optional. Supported durable-native tools are `read`, `write`, `edit`, and `bash`; an explicit tool list is an exact allowlist. If omitted, all four tools are available. Model values use `provider/model-id` and must resolve through Pi's model registry and configured login. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Preset files are read and cached when the extension loads. Changes apply to new agents after Pi `/reload`; they do not rewrite existing agents. Malformed present presets, unsupported settings/tools, and unavailable configured models fail closed with an error. When model or thinking is omitted, the new agent inherits Pi's current selection and follows later model/thinking changes. Explicit preset values stay fixed.

## Persistence and reports

Each managed agent is stored in a SQLite sidecar beside its Pi transcript, named `<transcript-base>.durable.sqlite`. Resuming that transcript reopens its agents, work, and pending reports. A deleted Pi transcript can leave an orphan sidecar; automatic cleanup is intentionally not implemented.

Reports are extension-authored custom steering messages, not user commands. When Pi is busy, a report is queued for the next model call after the current tool batch; when Pi is idle, it triggers a turn immediately. Steering can redirect the main agent's current task, but does not interrupt a tool already running. Each report includes a stable ID; the extension acknowledges it only after the entry is visible in Pi's session. Pi's transcript and the Durable sidecar cannot be committed atomically, so a crash or storage divergence at that boundary can still produce at-least-once delivery. Message counters are stored with the managed-agent registry and updated idempotently around stable report/request IDs.

Status and stats read Durable usage records for managed child conversations only. The main Pi conversation is excluded. Usage cost uses the best available provider-reported or model-catalog value, so aggregate costs may mix those sources.

## Running-agent footer

By default, in Pi's interactive TUI, the footer temporarily shows a moving spinner and a stacked status block for every running managed agent. Each block includes the agent name, its state (`queued`, `running`, or `idle`), short model ID and thinking level, cumulative assistant turns and executed tool uses, cumulative message in/out counts and cost, an estimated context-token count, and a one-line preview of its latest request. `[fresh]` appears only for an agent's first task. Idle and completed agents are omitted, and the built-in footer returns when no managed agent is running.

Use `/agents footer alwaysOn` to keep the custom footer visible and show managed-agent summaries even after they become idle. `/agents footer activity` restores the default behavior, showing only active agents and keeping the footer for the three-second hide delay. This setting lasts for the current Pi extension process.

The display refreshes about once a second while agents are running. Context usage is a proxy from the latest model-reported input usage and may lag until the agent's next model response. On short terminals, task previews are hidden before agent status lines. The extension recreates the normal cwd, usage, model, and extension-status footer lines while its custom multi-line footer is active.

## Safety and scope

“Read-only” is only an agent prompt instruction. The durable `bash` tool can modify files; it is not a security boundary. V1 does not copy Pi tool implementations into child agents, expose recursive subagent management inside children, or monitor transcript deletion.
