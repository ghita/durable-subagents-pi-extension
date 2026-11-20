# Durable Subagents Extension — Implementation Plan

**Status:** implementation completed against this plan. See `README.md` for usage and `test/` for verification.

## 1. Goal

Build a Pi extension that manages named background agents using `@earendil-works/pi-durable`, following the architecture in `packages/durable/test/examples/22-subagent-background.ts`. Agents have their own durable conversations, can continue work after the main Pi turn ends, and can be reopened after a process/session restart.

The extension provides both:

1. An explicit `/agents` command for deterministic human control.
2. A `subagent` tool for the main Pi agent to use in response to ordinary user text.

Both entry points must call the same agent-management service so their behavior and durable state stay consistent.

## 2. Settled product decisions

### Agent identity and lifecycle

- A managed agent has a meaningful name chosen by the user through `/agents` or by the main agent when it spawns one. Never invent anonymous names such as `agent-1`.
- If a requested name is already registered—even if idle—make it unique by adding/incrementing a numeric suffix. Keep the requested base name for preset lookup.
- Agents remain registered and reusable after work completes or is stopped. V1 does not delete individual agents or their durable history.
- `send` targets an existing named agent and steers it when it is busy; when idle, it starts work in that agent's existing conversation.
- `stop <name>` aborts current work and queued input, but retains the agent and its history.
- `stop --all` aborts all currently active managed agents in the current Pi session; idle agents remain registered. It does not stop the main Pi agent.
- Listing includes all registered agents, active first and idle afterward.

### Presets

- Presets are user-global only, under `<Pi agent dir>/agents/<preset-id>/agent.md`; resolve the base directory through Pi's configured agent directory (for example, `getAgentDir()`), not a hard-coded home path.
- The preset ID is the default spawned-agent name. `/agents` and the main agent may choose an alternate meaningful instance name.
- The extension reads/caches preset files when it loads. Edits take effect after Pi `/reload`; they do not automatically rewrite existing agents. New agents spawned after reload use the refreshed preset.
- `agent.md` has optional structured settings and a Markdown body used as the agent's system instructions. Proposed format:

  ```md
  ---
  tools: [read, bash]
  model: github-copilot/<model-id>
  thinking: high
  ---
  Instructions for this kind of agent go here.
  ```

  `tools`, `model`, and `thinking` are optional. Exact schema/parser is an implementation detail; validate it strictly.
- A configured tool list is an exact subset of the durable-native coding tools. If `tools` is omitted, enable all durable-native coding tools. When applying an explicit list, configure the Durable agent's enabled tools and model-visible tools consistently so the model cannot call a tool outside the preset's list.
- An unknown preset means an unconfigured agent and defaults to all durable-native coding tools. A present but malformed preset, an unsupported tool name, or an explicitly configured model unavailable through the inherited Copilot login must fail spawn with a clear error; do not silently broaden tools or fall back to another model.
- “Read-only” in v1 is a system-prompt instruction only. Bash may be included for `grep`/search, but it can also modify files; this is not a security boundary.

### Tools

- Do not copy/adapt Pi session tool implementations. Pi's public tool API exposes metadata but not executable definitions, and the callback/context protocols differ from durable tools.
- Use durable-native tools only. `@earendil-works/pi-durable/tools` currently provides `read`, `write`, `edit`, and `bash` (the `CodingTools` extension includes all four).
- A child with no configured tool list can use all of those tools. A preset can select an exact subset.

### Models and thinking

- V1 uses the parent's inherited Copilot login; do not ask users to configure a second provider login.
- The durable harness needs its own `Models` interface. Implement a small bridge to Pi's model registry/provider runtime so durable requests use the same configured Copilot credentials. Validate this early; do not build a parallel credential store.
- Model references in presets use the provider/model IDs understood by durable. The user expects the main Pi model names to be compatible.
- If a preset omits model or thinking, the agent inherits the current main Pi value and continues to follow subsequent main model/thinking changes. Explicit preset values stay fixed.
- Durable conversations copy agent configuration at creation, so the extension must persist whether each agent inherits model/thinking and update only inherited agents on Pi `model_select` / `thinking_level_select` events. An already in-flight request completes with the model/level it started with; subsequent requests use the new inherited value.

### Status, usage, and message counts

- `status <name>` shows active/idle state, cumulative cost, input/output/cache token totals, and message counts in both directions.
- “Incoming” counts each accepted instruction from the main agent to the managed agent, including its initial spawn instruction, exactly once—even if the work is later stopped.
- “Outgoing” counts each logical report actually delivered to the main agent, exactly once. A stopped task that produces no report does not increment it.
- `/agents stats` includes managed subagents only, not the main Pi agent. Show a grand total plus per-agent costs in descending cost order. Use the best available model usage cost (provider-reported where available, model-catalog estimates otherwise); be clear that totals can mix these sources.
- Cost/token totals are cumulative over the managed agent's recorded usage. Use durable usage records rather than recomputing model-call totals ad hoc where possible.

### Storage and cleanup

- Use one file-backed durable database per persisted Pi session, adjacent to/based on the current Pi transcript path. The path must be deterministic so the extension reopens the same database when that transcript is resumed.
- There is no transcript-deletion notification API used in v1. Do not monitor for transcript deletion or remove its database. An orphaned durable sidecar may remain if its Pi transcript is deleted; this is explicitly deferred.
- For a Pi session without a persisted transcript path, fail agent-management operations with a clear “persistent session required” message rather than silently using temporary storage.

## 3. Proposed user interface

Register one Pi slash command, `/agents`, with subcommands:

```text
/agents help
/agents presets
/agents list
/agents status <agent-name>
/agents spawn <name> [--preset <preset-id>] -- <task>
/agents send <agent-name> <message>
/agents stop <agent-name>
/agents stop --all
/agents stats
```

Suggested parsing rule for `spawn`: use an explicitly supplied `--preset`; otherwise look for a preset matching the requested name. If neither exists, create an unconfigured agent with all durable-native tools. The instance name defaults to the requested name (or preset ID, when selected); allow a clear optional name override if needed. Resolve uniqueness after choosing the base name, while keeping the preset ID unchanged.

Use Pi command argument completions to:

- Suggest preset IDs after `spawn` and after `--preset`.
- Suggest registered agent names after `send`, `status`, and `stop`.
- Show actions and currently available preset names in `/agents help` (and/or the command description).

The `subagent` Pi tool should support equivalent operations (`spawn`, `send`, `list/status`, `stop`, `stop all`, `stats`) and use the same service as the slash command. Its description/instructions should include the cached preset IDs and remind the main agent to choose a relevant configured preset/tool set and a meaningful instance name.

**Interpretation to preserve:** ordinary natural-language requests let the main agent decide whether to spawn/send and which configured preset/tools fit the task. Direct `/agents spawn` uses a matching preset's configuration when available, otherwise all durable-native coding tools. If a truly ad-hoc per-spawn tool subset is desired in addition to presets, add an optional validated `tools` parameter to the model tool; do not allow it to override a preset's explicit tool list.

## 4. Runtime architecture

### Extension lifecycle

1. On extension/session startup, resolve and validate global presets; cache them until reload.
2. Require `ctx.sessionManager.getSessionFile()` to be defined for durable mode.
3. Derive a stable adjacent SQLite path from the transcript path; open it with `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node`.
4. Construct the durable registry and install task/tool extensions on every open. Include durable-native coding tools.
5. Build the model bridge around the current Pi model registry and inherited Copilot auth.
6. Open the Harness, obtain the stable durable root conversation, and configure its `cwd`, currently selected model, and thinking level. The root is a durable control/ownership context; Pi remains the user-facing main conversation.
7. Call `harness.resume()` so pending durable reporter and agent tasks continue after restart.
8. On Pi model/thinking selection events, update the durable root and all managed agents marked as inherited. Do not touch explicit per-agent overrides.
9. On `session_shutdown`, close the Harness/storage cleanly. The durable records remain and are reopened on resume/reload.

Treat startup and shutdown as idempotent. On `/new`, `/resume`, `/fork`, or `/reload`, close the previous runtime before binding the replacement session's transcript and database.

### Durable state and tasks

Adapt the example's structure:

- A conversation-scoped `Subagents` document on the durable root maps names to child conversation IDs and records each agent's preset ID, model/thinking inheritance flags, message counters, and any needed delivery-deduplication keys. Use an initial/fork policy that does not copy managed agents into an unrelated Pi fork/session.
- An anchor task owns each child conversation so it outlives the main agent's turn and remains usable after the anchor finishes.
- A reporter task sends a durable submission to the child with a stable request ID and `whenBusy: "steer"`, waits for the answer, then reports it to the real Pi main session.
- Reporter and anchor tasks are background tasks so durable work is not coupled to the main turn's idle/abort boundary.
- Child conversations use only the selected durable extensions/tools; no subagent-management tool is installed in children, so recursive spawning is unavailable in v1.
- Store durable child conversation IDs, not live conversation handles, in the registry.

### Bridging reports back into Pi

The example reports to a durable “main” conversation, but the extension's real main conversation is Pi's session. Bridge completed reports through Pi's extension API as custom `pi.sendMessage` steering messages that participate in context. While Pi is busy, the report is queued for the next model call after the current tool batch; when Pi is idle, trigger a turn immediately. Include the agent name and a stable report ID in the message/details.

Because the durable database and Pi transcript are separate stores, report delivery cannot be one atomic transaction. Make delivery idempotent as far as the public Pi API permits: persist a stable report ID, check for an already-recorded report before retrying after reopen, and increment the logical outgoing-report counter once. Add a recovery test for a crash around report delivery. Do not inject a report as an actual user command; use an extension-authored message so it cannot dispatch slash commands.

### Agent configuration application

- Resolve preset and instance name before creation.
- Validate model/tool settings before committing a child conversation/anchor, so invalid config cannot leave partial durable records.
- Create the anchor and child in one durable commit, then apply `AgentChange` for instructions, cwd, optional model, and optional thinking. For a tool allowlist, configure both Durable's enabled tool selection (`tools`) and its model-visible selection (`modelTools`) consistently; omitted `tools` leaves all installed durable coding tools available.
- For inherited model/thinking, keep explicit inheritance metadata in `Subagents`; configure the child to the current parent value at creation and update it on relevant Pi events.
- For explicit preset model/thinking, configure once and leave unchanged by parent events.
- Set the child working directory to the Pi session's cwd, unless a separately agreed per-preset cwd policy is added later.
- Preserve the approved `agent.md` prompt as the child instructions, together with a small invariant instruction identifying the agent by its instance name and requiring it to answer the main agent.

## 5. Usage and stats implementation

- Read each managed child's durable `UsageDoc` (`pi.usage`) for cumulative model token/cost totals. Sum only managed child conversations, not durable control/root usage and not Pi's main model usage.
- Combine per-model `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost.total` for status. If the aggregate spans providers/models, report a clear aggregate and optionally per-model details.
- `/agents stats` calculates the sum over registered managed agents and prints the total followed by agent rows sorted by `cost.total` descending. Keep ties stable (e.g. alphabetical by name).
- Message counters live in the registry document. Update them idempotently around stable durable submission/reporter IDs; handle missing counter fields as zero for compatibility with any earlier stored document version.
- `list`/status activity follows the example: a child is active while its live run is present; otherwise it is idle. Show active agents before idle agents, with stable secondary sorting.

## 6. Implementation phases

### Phase A — Scaffold and compatibility spike

- Add the extension package manifest, TypeScript entry point, test runner, and required Pi/durable dependencies. The repository currently has no implementation scaffold.
- Verify exact Pi extension APIs for commands, tool registration, session lifecycle, message injection, model/thinking events, and global agent-dir resolution.
- Prototype the smallest `Models` bridge from Pi's `ModelRegistry` to the methods `pi-durable` uses (`getModel`, streaming, completion, and any deferred methods needed by the selected Copilot model). Test a real Copilot-authenticated request without copying credentials into a second store.
- If that bridge cannot support the chosen Copilot model path safely, stop and report the concrete API gap before building the rest.

### Phase B — Presets

- Implement global directory discovery and Markdown/frontmatter parsing.
- Validate preset IDs, tool names, model references, thinking levels, duplicate/invalid settings, and prompt body.
- Implement cache refresh on extension reload and `/agents help`/autocomplete from the cached preset set.
- Unit-test missing preset (generic/all-tools fallback) separately from malformed existing preset (fail closed).

### Phase C — Durable runtime and subagent lifecycle

- Implement deterministic session-file-to-SQLite path mapping and persisted-session guard.
- Create the durable root, install tasks/extensions, resume on reopen, and close on Pi session shutdown/switch.
- Implement spawn, send/steer, status/list, stop one, and stop-all over shared service functions.
- Persist name uniqueness, agent metadata, and idempotent message counters.
- Test restart/reopen while a child is working and while a reporter is pending.

### Phase D — Pi-facing command/tool and reports

- Register `/agents` and its parser/completions/help.
- Register the `subagent` Pi tool for ordinary user requests; include the available preset names and the rules for choosing them.
- Bridge reporter tasks to Pi custom messages and verify delivery while Pi is busy, idle, shutting down, and reopening.
- Ensure child settings use the right durable tool allowlist and never expose Pi's incompatible tool callbacks.

### Phase E — Model/thinking inheritance and telemetry

- Set the durable root's initial model/thinking from the current Pi session.
- Propagate Pi changes only to agents whose corresponding fields are inherited.
- Verify explicit preset overrides remain unchanged and an unavailable explicit model fails before agent creation.
- Implement per-agent status usage and aggregate `/agents stats` with descending-cost ordering.

### Phase F — Tests, docs, and handoff verification

- Add unit tests for parser, path mapping, naming/collisions, preset lookup, validation, cost aggregation, output ordering, and counters.
- Add durable integration tests with faux models and persistent SQLite for spawn/send/steer/stop-all/restart/report behavior.
- Add Pi extension tests/mocks for slash command completion, natural-language tool routing, model/thinking change propagation, and session shutdown/reopen.
- Manually test on a persistent Pi session with Copilot login: spawn configured and unconfigured agents, send/steer, stop one/all, inspect status/stats, change model/thinking, `/reload`, resume the transcript.
- Document the preset format, global path, commands, read-only limitation, Copilot requirement, and deferred transcript-deletion cleanup.

## 7. Acceptance criteria

- A named subagent continues independently of the main Pi turn and resumes after extension/process restart.
- Ordinary Pi text can cause the main agent to invoke the shared `subagent` tool; slash commands work without relying on LLM interpretation.
- Preset IDs are discoverable from help/autocomplete; configured settings apply on spawn; missing preset uses all durable-native coding tools; malformed/unsupported configuration fails visibly.
- Uniqueness checks include idle agents and do not create anonymous names.
- Stop operations retain registered conversations/history; `stop --all` only aborts active managed agents.
- Inherited model/thinking follows main changes; explicit preset settings remain fixed.
- Per-agent status and aggregate stats use only managed-agent usage; stats are descending by cost and exclude the main Pi agent.
- Incoming/outgoing message counts follow the agreed definitions and do not double count durable retries.
- No Pi tool execution adapters are introduced; no transcript-deletion cleanup is attempted in v1.

## 8. Assumptions for the implementer

1. A persisted Pi transcript is required for durable subagents; ephemeral sessions return a clear unsupported message.
2. Use a sidecar SQLite file associated with the Pi transcript. Transcript deletion may leave the sidecar behind; cleanup is out of scope.
3. A custom `/agents spawn` name matching a preset uses that preset; an optional explicit preset override may allow a different runtime name.
4. For ordinary user text, the main agent chooses a relevant configured preset/tool set. If none is selected, use all durable-native coding tools. If the product intent is instead a per-spawn arbitrary tool subset, add that as an explicit tool argument and preserve configured preset restrictions.
5. Updating a preset followed by `/reload` affects newly spawned agents only; existing agent instructions/tools/settings are durable snapshots, except inherited model/thinking values which continue to track Pi changes.
6. Report delivery crosses two stores (durable DB and Pi transcript); use stable IDs and best-effort deduplication, and document any remaining at-least-once edge case.
