# Agent preset files

> **Status:** Supported by the extension. Preset files are loaded once at extension initialization and refreshed with Pi `/reload`.

## Location and discovery

Presets remain user-global and live under Pi's configured agent directory. The extension resolves the base directory with Pi's `getAgentDir()` configuration; do not hard-code a home-directory path.

```text
<Pi agent directory>/agents/**/*.md
```

Discovery is recursive. The Markdown filename and folder names do not determine the preset ID; the frontmatter `name` does. A Markdown file without a `name` field is not an agent definition and is ignored, so supporting/reference Markdown can live alongside agents. A file with `name` is an agent definition and must satisfy the full schema below.

Example layout:

```text
<Pi agent directory>/agents/
├── research/
│   ├── researcher.md
│   └── sources.md          # Supporting document; no `name`, so not a preset
└── review/
    └── code-reviewer.md
```

Preset files are loaded and cached when the extension loads. Changes take effect for newly spawned agents after Pi `/reload`; they do not rewrite existing agents.

## Frontmatter and prompt body

Each agent definition has YAML frontmatter followed by a non-empty Markdown instruction body:

```md
---
name: researcher
description: Research a topic and return a concise, sourced report.
tools: [read, bash]
model: inherit
effort: inherit
---

Investigate the assigned topic. Cite sources and distinguish evidence from uncertainty.
```

### Required fields

| Field | Meaning |
| --- | --- |
| `name` | Required preset ID. It must match Pi's current ID rule: 1–64 ASCII letters, numbers, `_`, or `-`, starting with a letter or number. IDs must be unique across the recursively discovered files. Duplicate IDs invalidate the colliding definitions; the extension must not choose one based on scan order. |
| `description` | Required short explanation of when this agent is useful. Shown in `/agents presets` and supplied to the parent agent to help it select a preset. |
| `model` | Optional. Omit it or use `inherit` to follow the parent agent's model; explicit Pi model references use `provider/model-id` form. An inherited model follows later parent model changes; an explicit model stays fixed. Explicit references must resolve through Pi's model registry and configured provider authentication. |
| `effort` or `thinking` | Required. Use one field, not both. `effort` is the canonical preset field; `thinking` is accepted as a Pi-native alias. Use `inherit` to follow the parent agent's thinking level, or a supported Pi level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Inherited effort follows later parent changes; an explicit value stays fixed. Pi maps either field to its thinking-level setting. |

### Optional `tools`

`tools` is an optional YAML list of Pi durable-native tool names:

```yaml
tools: [read, bash]
```

The supported names are `read`, `write`, `edit`, and `bash`. Listing tools is an exact allowlist. If `tools` is omitted, the agent receives all four tools. An empty list is a valid allowlist that gives the agent no tools. Claude Code tool names are not accepted or translated.

### Optional `codemode`

`codemode` is an optional boolean. When `true`, the managed agent receives Pi Durable's Code Mode tool, which can compose calls only to the tools enabled for that preset. It does not expand the preset's `tools` allowlist. Code Mode's `models.*` helpers are disabled for managed agents. Omit the field or set it to `false` to disable Code Mode.

### Unsupported fields and validation

Only `name`, `description`, `tools`, `model`, `codemode`, and one of `effort` or `thinking` are supported. Unknown frontmatter fields are errors; Claude-specific options such as `disallowedTools`, `permissionMode`, `hooks`, or `mcpServers` are not silently ignored. Malformed frontmatter, missing required fields, invalid values, duplicate IDs, and an empty instruction body must produce clear preset errors and must not silently broaden tool access or substitute another model.

The field names follow Claude Code's custom-subagent convention, but this is not full value/runtime compatibility. In particular, tool names are Pi-specific; `provider/model-id` is Pi-specific; and Pi's `effort: inherit`, `off`, and `minimal` values are outside Claude Code's documented effort values.

## Packaged defaults and installation

The extension ships lowercase `scout` and `review` presets. Both inherit the current model, use only `read` and `bash`, and enable Code Mode with model helpers disabled. Scout uses low thinking; Review uses high thinking. Their instructions are included in the packaged `presets/` Markdown files.

Use `/agents presets` to see installed presets and which packaged defaults are missing. `/agents install` copies every missing packaged preset into `<Pi agent dir>/agents/durable-subagents-pi-extension/` (or a numbered sibling if that directory path is occupied); it checks preset identity by frontmatter `name`, is idempotent, and never overwrites an existing preset ID or file. If a target filename is occupied by unrelated content, installation uses another unused filename. Installed files belong to the user-global preset library and remain there if the extension package is removed. After new files are installed, run `/reload` before using the presets. Package upgrades do not replace user copies; edit or remove those files yourself if you want to change them.

## References from an agent prompt

A prompt may tell its agent to consult a supporting file, but the extension does not automatically include adjacent Markdown files in the system prompt. The agent must read a referenced file with an available tool. Supporting files without a `name` field are not loaded as separate presets.
