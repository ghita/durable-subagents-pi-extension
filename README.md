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
```

Names containing spaces can be quoted. If a spawn name matches a preset ID, that preset is used by default; `--preset` can select a different preset while retaining the chosen instance name. A missing preset is an unconfigured, all-tools agent. Name collisions—including with idle agents—receive a numeric suffix. Agents remain registered after completing or stopping work, and later `send` operations reuse their conversation. A send to busy work is steered into the existing agent. `stop --all` affects managed work only, never the main Pi agent.

The `subagent` tool supports `spawn`, `send`, `list`, `status`, `stop`, `stop-all`, and `stats`. It shares the same registry, presets, history, and service as `/agents`.

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

Reports are extension-authored custom follow-up messages, not user commands. They include a stable report ID; the extension checks Pi's session entries before retrying and acknowledges a report only after the entry is visible there. Pi's transcript and the Durable sidecar cannot be committed atomically, so a crash or storage divergence at that boundary can still produce at-least-once delivery. Message counters are stored with the managed-agent registry and updated idempotently around stable report/request IDs.

Status and stats read Durable usage records for managed child conversations only. The main Pi conversation is excluded. Usage cost uses the best available provider-reported or model-catalog value, so aggregate costs may mix those sources.

## Safety and scope

“Read-only” is only an agent prompt instruction. The durable `bash` tool can modify files; it is not a security boundary. V1 does not copy Pi tool implementations into child agents, expose recursive subagent management inside children, or monitor transcript deletion.
