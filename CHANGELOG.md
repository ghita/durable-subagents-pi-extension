# Changelog

## [0.3.0] - 2026-11-28

- Discover and validate recursive agent preset definitions.
- Bundle Scout and Review presets, with an explicit additive install command and Code Mode support.
- Create the durable SQLite sidecar lazily and resume existing managed-agent state on session startup ([issue #3](https://github.com/ghita/durable-subagents-pi-extension/issues/3)).

## [0.2.0] - 2026-11-26

### Highlights

- **Bounded Herdr agent panes:** Agent displays now share a configurable per-tab pane budget (default: 3). Active agents get priority; idle panes can be reused, and tracked panes are reconciled on resume.
- **Opt-in OpenTelemetry:** Export managed-agent traces and metrics over OTLP HTTP/protobuf or gRPC. Telemetry is disabled by default; see the [telemetry guide](https://github.com/ghita/durable-subagents-pi-extension/blob/main/docs/telemetry.md) for setup and data-handling details.
- **More reliable reporting and runtime handling:** Improved report delivery and startup error handling, with additional tests around agent lifecycle and pane recovery.
- **Release automation:** Added CI checks and an npm publishing workflow with provenance.
