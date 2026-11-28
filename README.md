# Pi Durable Subagents

**Delegate work to background agents, keep working while they run, and return to the same named agents for follow-up tasks.**

Pi Durable Subagents is a Pi extension for managing named, reusable agents backed by `@earendil-works/pi-durable`. Ask Pi to delegate work to an agent, or manage agents directly with `/agents`.

<p align="center">
  <img src="docs/images/subagent-delegation.png" alt="Pi delegates a task to a named joke agent, continues its turn, and receives the agent's report while the child agent is visible in a separate terminal pane." width="100%">
</p>
<p align="center"><em>Delegate from the main Pi conversation, keep working, and receive the agent's report back in the conversation. The right-hand pane shows the child agent at work.</em></p>

## Why use it?

- **Delegate and keep going.** Spawn work asynchronously; the agent reports back to the main Pi conversation when it finishes.
- **Reuse named agents.** Each agent keeps its own durable conversation. Send follow-up work to the same agent, including after resuming the Pi session.
- **Choose how to work.** Ask Pi to delegate work to an agent, or manage agents yourself with `/agents`.
- **See what's happening.** Track active work, requests, usage, and costs in the Pi footer and with agent status commands.
- **Start with packaged presets.** Run `/agents install` to add the included `scout` and `review` agents without overwriting existing presets; customize their tool allowlist, model, or thinking level as needed.
- **Optionally use live Herdr panes.** In a Herdr-managed terminal, a bounded pool of panes shows agent activity without limiting how many agents can work.

## How it works

Pi's agent delegation and `/agents` commands use the same extension service and agent registry. Child agents have their own durable conversations. Their reports return to the main Pi agent as steering messages; if Pi is busy, a report is delivered after the current tool batch.

```mermaid
flowchart LR
    User[You] --> Main[Main Pi agent]
    Main -->|agent request| Service[Durable Subagents extension]
    User -->|/agents commands| Service
    Service <--> Registry[Agent registry and SQLite sidecar]
    Service -->|spawn or send task| Child[Named durable sub-agents]
    Child -->|completed report| Service
    Service -->|steering message| Main
    Child -. optional activity view .-> Herdr[Herdr pane]
```

The main-agent/sub-agent communication design was inspired by [Pi's background subagent example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-background.ts).

## Install

Install from npm:

```sh
pi install npm:pi-durable-subagents-extension
```

Or install directly from GitHub:

```sh
pi install git:github.com/ghita/durable-subagents-pi-extension
```

For local development, load the extension directly:

```sh
pi --extension ./src/index.ts
```

## Requirements

- Pi `1.5.2` or compatible.
- A persisted Pi session transcript. Temporary or transcript-less sessions cannot use durable agents.
- A model available through Pi's `ModelRegistry` and configured provider authentication. The extension reuses Pi's model registry; it does not ask for or store a second credential.

## Quick start

Install the packaged presets if they are missing, then reload Pi before using newly installed presets:

```text
/agents install
/reload
/agents presets
```

For example, start the Scout preset with:

```text
/agents spawn scout -- Map the main modules and report how they fit together.
```

Or ask Pi to delegate a task in natural language, for example:

> Start a named agent called `researcher` and ask it to compare the main approaches in this project. Continue with my other request while it works, then summarize its report when it arrives.

Or spawn and manage an agent directly:

```text
/agents spawn researcher -- Compare the main approaches in this project and report the tradeoffs.
/agents list
/agents send researcher Check whether the project has tests for those approaches.
/agents status researcher
```

Pi's agent tool supports `spawn`, `send`, `list`, `status`, `stop`, `stop-all`, and `stats`. It shares the same registry, presets, history, and service as `/agents`.

## Commands

```text
/agents help
/agents presets
/agents install
/agents list
/agents status <name>
/agents spawn <name> [--preset <preset-id>] -- <task>
/agents send <name> <message>
/agents stop <name>
/agents stop --all
/agents stats
/agents footer alwaysOn|activity
/agents panes
/agents panes <K>
```

Names containing spaces can be quoted. If a spawn name matches a preset ID, that preset is used by default; `--preset` can select a different preset while retaining the chosen instance name. A missing preset is an unconfigured, all-tools agent. Name collisions—including with idle agents—receive a numeric suffix. Agents remain registered after completing or stopping work, and later `send` operations reuse their conversation. A send to busy work is steered into the existing agent. `stop --all` affects managed work only, never the main Pi agent.

## Features in detail

### Durable conversations and reports

Each managed agent is stored in a SQLite sidecar beside its Pi transcript, named `<transcript-base>.durable.sqlite`. Resuming that transcript reopens its agents, work, and pending reports. A deleted Pi transcript can leave an orphan sidecar; automatic cleanup is intentionally not implemented.

Reports are extension-authored custom steering messages, not user commands. When Pi is busy, a report is queued for the next model call after the current tool batch; when Pi is idle, it triggers a turn immediately. Steering can redirect the main agent's current task, but does not interrupt a tool already running. Each report includes a stable ID; the extension acknowledges it only after the entry is visible in Pi's session. Pi's transcript and the Durable sidecar cannot be committed atomically, so a crash or storage divergence at that boundary can still produce at-least-once delivery. Message counters are stored with the managed-agent registry and updated idempotently around stable report/request IDs.

Status and stats read Durable usage records for managed child conversations only. The main Pi conversation is excluded. Usage cost uses the best available provider-reported or model-catalog value, so aggregate costs may mix those sources.

### Presets

Presets are user-global Markdown files discovered recursively under:

```text
<Pi configured agent directory>/agents/**/*.md
```

The base directory comes from Pi's `getAgentDir()` configuration. A file defines a preset only when its YAML frontmatter contains `name`; Markdown without `name` is ignored and can be used as supporting documentation. The frontmatter `name`, not the filename or folder, is the preset ID and must be unique. For example:

```md
---
name: researcher
description: Research a topic and return a concise, sourced report.
tools: [read, bash]
model: inherit
effort: high
---

Search the project and return a concise summary with file references.
```

`name`, `description`, and either `effort` or Pi-native `thinking` are required. `model` is optional and defaults to the parent model; it also accepts `inherit` or `provider/model-id`. Explicit model references must resolve through Pi's model registry and configured provider authentication. `effort` (or its `thinking` alias) accepts `inherit` or `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (mapped to Pi's thinking level). Inherited model and effort follow later parent changes; explicit values remain fixed for existing agents.

`tools` is optional and Pi-specific. Supported durable-native tools are `read`, `write`, `edit`, and `bash`; an explicit list (including an empty list) is an exact allowlist. If omitted, all four tools are available. Claude Code tool names and Claude-only settings are not supported. Unknown frontmatter fields, malformed definitions, duplicate IDs, invalid settings, and empty instruction bodies are reported as preset errors and never silently broaden tool access or substitute another model. The `/agents presets` listing includes each description and its available tools; the main agent receives the descriptions to help it select a useful preset.

Preset files are read and cached when the extension loads. Changes apply to new agents after Pi `/reload`; they do not rewrite existing agents.

The extension ships these defaults:

| Preset | Use it for | Model | Thinking | Tools | Code Mode |
|---|---|---|---|---|---|
| `scout` | Codebase reconnaissance with evidence and file paths | Inherited | Low | `read`, `bash` | Yes; model helpers disabled |
| `review` | Reviewing changes for correctness, security, and regressions | Inherited | High | `read`, `bash` | Yes; model helpers disabled |

`/agents presets` identifies missing defaults and recommends `/agents install`. Installation copies all missing packaged presets into the user-global agent library, skips existing IDs without overwriting them, and is safe to repeat. Copies remain after package removal, and upgrades do not replace them. Run `/reload` after installing presets before using them. The preset instructions are Markdown files under `presets/`.

See [the agent preset file guide](docs/agents/agent-files.md) for the complete schema, installation behavior, and portability caveats.

### Running-agent footer

By default, in Pi's interactive TUI, the footer temporarily shows a moving spinner and a stacked status block for every running managed agent. Each block includes the agent name, its state (`queued`, `running`, or `idle`), short model ID and thinking level, cumulative assistant turns and executed tool uses, cumulative message in/out counts and cost, an estimated context-token count, and a one-line preview of its latest request. `[fresh]` appears only for an agent's first task. Idle and completed agents are omitted, and the built-in footer returns when no managed agent is running.

Use `/agents footer alwaysOn` to keep the custom footer visible and show managed-agent summaries even after they become idle. `/agents footer activity` restores the default behavior, showing only active agents and keeping the footer for the three-second hide delay. This setting lasts for the current Pi extension process.

The display refreshes about once a second while agents are running. Context usage is a proxy from the latest model-reported input usage and may lag until the agent's next model response. On short terminals, task previews are hidden before agent status lines. The extension recreates the normal cwd, usage, model, and extension-status footer lines while its custom multi-line footer is active.

### Herdr live agent panes

In Herdr-managed terminals, the extension can display agent activity in a bounded pool of panes. The default budget is three; it limits displays, not agent execution. Configure the budget with `/agents panes`. See the [Herdr live agent panes guide](docs/herdr.md) for requirements, assignment behavior, and recovery details.

### Opt-in OpenTelemetry

Telemetry export is disabled unless `DURABLE_SUBAGENTS_OTLP_ENDPOINT` is set. The value is the OTLP collector base endpoint (for example, `http://localhost:4318`); HTTP/protobuf is the default transport and the extension sends traces to `/v1/traces` and metrics to `/v1/metrics`. Set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` for an OTLP/gRPC collector. Standard OpenTelemetry headers, signal-specific endpoints, timeouts, resource attributes, and metric export interval settings are also honored. For example:

```powershell
$env:DURABLE_SUBAGENTS_OTLP_ENDPOINT = "http://localhost:4318"
$env:OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer%20collector-token"
pi
```

```sh
DURABLE_SUBAGENTS_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer%20collector-token' pi
```

When enabled, traces cover managed-agent requests through child model/tool activity and report delivery. Task text, assistant responses, tool-call arguments, and tool outputs are included (each field is capped at 64 KiB with truncation metadata); hidden reasoning is excluded, and credential-like keys in tool arguments are redacted. Free-form task and tool content may still contain sensitive data, so configure a trusted collector and review its access and retention policies. Telemetry setup/export failures are fail-open: agent work continues and telemetry may be lost. The extension does not write operational details or task content to a plain-text log. See the [full telemetry guide](docs/telemetry.md) for HTTP/protobuf and gRPC setup, configuration, and troubleshooting.

## Development

Run the offline checks with:

```sh
npm test
npm run typecheck
```

The optional `npm run test:model-bridge` makes a real model request through Pi's configured provider authentication and is not part of the offline test suite. It uses Pi's configured default model, or you can set `PI_DURABLE_MODEL=provider/model` to choose one.
