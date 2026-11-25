---
title: "ADR-0001: Opt-In OpenTelemetry for Managed-Agent Telemetry"
status: "Accepted"
date: "2026-11-25"
authors: "Project maintainer"
tags: ["architecture", "observability", "privacy"]
supersedes: ""
superseded_by: ""
---

# ADR-0001: Opt-In OpenTelemetry for Managed-Agent Telemetry

## Status

**Accepted**

## Context

The extension needs detailed, correlated diagnostics for managed-agent work so failures such as a tool call failing without a report can be investigated end to end. The existing extension logger is a limited plain-text exception/lifecycle log. The repository's `@earendil-works/pi-telemetry` contract and Durable's built-in instrumentation already provide a vendor-neutral telemetry boundary, but the extension does not configure an exporter and Durable's built-in data is content-free.

Users want full task prompts, assistant responses, tool-call arguments, and tool outputs to be available for diagnosis, while retaining control over the collector. Such content may include private code or other user data. Phoenix is a convenient local development collector, but the design must also work with other OTLP-compatible collectors.

## Decision

- **DEC-001**: Implement a vendor-neutral OpenTelemetry adapter for the existing `pi-telemetry` context/span/metrics/propagation contracts, and export through OTLP. Do not couple instrumentation to Phoenix APIs; Phoenix is one compatible collector.
- **DEC-002**: Configure the collector using `DURABLE_SUBAGENTS_OTLP_ENDPOINT`. The presence of this variable is the explicit opt-in; when absent, export is disabled. Support standard OpenTelemetry configuration for protocol and collector headers as needed.
- **DEC-003**: Trace a managed-agent request end to end: accepted work, child model activity, tool calls and results, failures, report creation, and report delivery. Do not include unrelated main-agent activity.
- **DEC-004**: Include the managed task text, assistant responses, tool-call arguments, and tool outputs. Do not export hidden model reasoning or provider authentication material such as credentials and headers. Cap each payload field at 64 KiB and record truncation metadata.
- **DEC-005**: Export traces and metrics. Remove the extension's plain-text file logger; retain only a minimal local console/TUI warning for telemetry initialization or export failures.
- **DEC-006**: Make telemetry fail-open. Telemetry failures must not block or change agent work. Do not add a durable telemetry spool or custom retry system; lost telemetry is acceptable.

## Consequences

### Positive

- **POS-001**: End-to-end traces correlate managed-agent tasks, model/tool activity, failures, and report delivery.
- **POS-002**: OTLP keeps the exporter portable across compatible collectors and avoids Phoenix-specific instrumentation lock-in.
- **POS-003**: Endpoint configuration makes export explicitly user-controlled and disabled by default.
- **POS-004**: Payload caps constrain individual large content fields and make truncation visible.
- **POS-005**: Fail-open export prevents observability failures from disrupting agent work.

### Negative

- **NEG-001**: Exported prompts, responses, arguments, and tool outputs may contain private or sensitive user data; users must trust and configure the endpoint accordingly. Arbitrary free text cannot be guaranteed secret-free.
- **NEG-002**: The adapter and additional subagent instrumentation add maintenance and schema-mapping work.
- **NEG-003**: Payloads over the cap are incomplete, and telemetry may be lost when export fails because no durable retry queue is kept.
- **NEG-004**: Removing the file logger means operational failures are visible only through telemetry where export works, plus minimal local warnings.

## Alternatives Considered

### Phoenix-specific instrumentation

- **ALT-001**: **Description**: Instrument the extension directly against Phoenix-specific APIs or SDKs.
- **ALT-002**: **Rejection Reason**: The user requires compatibility with other collectors; Phoenix should be a development setup, not an architectural dependency.

### Keep file logging as the primary diagnostic view

- **ALT-003**: **Description**: Extend the existing local plain-text logger with more agent and tool details.
- **ALT-004**: **Rejection Reason**: It does not provide the requested correlated, inspectable trace view and duplicates a limited diagnostic channel once structured telemetry is available.

### Disable payload capture

- **ALT-005**: **Description**: Export only content-free metadata, as Durable's built-in schema currently does.
- **ALT-006**: **Rejection Reason**: The user explicitly wants prompts, tool calls, and responses available to diagnose failures; payload inclusion is guarded by explicit endpoint opt-in and per-field caps.

## Implementation Notes

- **IMP-001**: Pass the adapter through Durable's `HarnessOptions.telemetry` and use the same context for extension-owned spans.
- **IMP-002**: Add subagent-specific instrumentation for payloads; do not assume Durable's built-in content-free spans capture transcript contents.
- **IMP-003**: Use standard OTel trace and metric exporters and propagate trace context through Durable tasks.
- **IMP-004**: Enforce the 64 KiB cap per payload field and attach explicit truncation/original-size metadata.
- **IMP-005**: Ensure exporter/setup exceptions are caught, reported locally in a minimal way, and never escape into agent work.
- **IMP-006**: Document that the endpoint receives sensitive task and tool content and that the collector controls retention.
- **IMP-007**: Test disabled-by-default behavior, end-to-end span correlation, payload caps, exporter failures, and non-interference with agent execution.

## References

- **REF-001**: Repository package `@earendil-works/pi-telemetry` — vendor-neutral telemetry contracts; no exporter.
- **REF-002**: Durable `HarnessOptions.telemetry` — host-provided telemetry context.
- **REF-003**: [OpenTelemetry JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/)
- **REF-004**: [OpenTelemetry OTLP exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/)
- **REF-005**: [Arize Phoenix OTEL setup](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-using-phoenix-otel)
