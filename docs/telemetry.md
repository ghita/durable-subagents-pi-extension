# Managed-agent OpenTelemetry

This extension can export managed-agent diagnostics to any OpenTelemetry Protocol (OTLP) collector. The exporter is vendor-neutral; Phoenix is one option for local inspection.

Telemetry is **opt-in**. Export is disabled unless `DURABLE_SUBAGENTS_OTLP_ENDPOINT` is set when the managed-session runtime starts. The standard `OTEL_EXPORTER_OTLP_ENDPOINT` variable does not enable this extension's exporter.

## Quick start with Phoenix

The repository includes a local Phoenix development collector. It binds its ports to loopback and disables authentication, so use it only for local development:

```sh
docker compose -f scripts/docker-compose.yml up -d
```

Phoenix UI: <http://localhost:6006>

### HTTP with protobuf (default)

The default protocol is `http/protobuf`. The extension appends `/v1/traces` and `/v1/metrics` to the configured base endpoint:

**PowerShell**

```powershell
$env:DURABLE_SUBAGENTS_OTLP_ENDPOINT = "http://localhost:6006"
$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
pi
```

**Bash / zsh**

```sh
DURABLE_SUBAGENTS_OTLP_ENDPOINT=http://localhost:6006 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
pi
```

### gRPC

To use OTLP/gRPC, set the protocol to `grpc` and point the extension endpoint at the collector's gRPC listener. The included Phoenix Compose setup listens on `localhost:4317`:

**PowerShell**

```powershell
$env:DURABLE_SUBAGENTS_OTLP_ENDPOINT = "http://localhost:4317"
$env:OTEL_EXPORTER_OTLP_PROTOCOL = "grpc"
pi
```

**Bash / zsh**

```sh
DURABLE_SUBAGENTS_OTLP_ENDPOINT=http://localhost:4317 \
OTEL_EXPORTER_OTLP_PROTOCOL=grpc \
pi
```

Set these variables in the environment of the Pi process. The extension reads them when it opens a managed-session runtime; changing them while that runtime is already open does not reconfigure its exporters.

## Configuration reference

| Variable | Meaning |
| --- | --- |
| `DURABLE_SUBAGENTS_OTLP_ENDPOINT` | **Required opt-in.** Collector base endpoint. For HTTP, defaults to `http/protobuf` and the extension appends `/v1/traces` and `/v1/metrics`. For gRPC, this is the collector address passed to both exporters. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `grpc`. Other values disable export and produce a warning. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` headers shared by traces and metrics. Header values are URL-decoded, so encode spaces and commas (for example, `Authorization=Bearer%20token`). |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Additional/overriding headers for traces. |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | Additional/overriding headers for metrics. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional signal-specific endpoint. Used as supplied; for HTTP it replaces the URL that would otherwise be built from the base endpoint. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Optional signal-specific endpoint, with the same behavior as the traces endpoint. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Export timeout in milliseconds; defaults to `10000`. |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | Traces-specific timeout in milliseconds; overrides the shared timeout. |
| `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` | Metrics-specific timeout in milliseconds; overrides the shared timeout. |
| `OTEL_SERVICE_NAME` | Resource service name; defaults to `pi-durable-subagents`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Comma-separated resource `key=value` pairs. Values are URL-decoded. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metrics export interval in milliseconds; defaults to `60000`. |

Only positive integer timeout and interval values are accepted; invalid values use the defaults. Signal-specific headers are applied after shared headers, so a signal-specific value replaces a shared value with the same header name. Do not commit collector credentials to the repository.

### Endpoint examples

For HTTP, a base endpoint of `http://collector:4318` becomes:

```text
http://collector:4318/v1/traces
http://collector:4318/v1/metrics
```

If `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, its value is used directly rather than having `/v1/traces` appended. With gRPC, the base endpoint is used directly and no HTTP signal paths are added.

## What is exported

The extension passes the telemetry context into Durable and records managed-agent request, execution, and report-delivery activity. Typical span names include:

- `durable_subagents.request` — accepted `spawn` or `send`, including the operation, agent name, and task text.
- `durable_subagents.execution` — the child submission and its outcome.
- `pi.durable.submit` — a Durable-owned span for `Conversation.submit()` admission. In this extension it is emitted when `AgentReporter` calls `child.submit()` in `src/tasks.ts`. For input/continue submissions, Durable starts it as a root trace and links it to the caller; it covers admission, not completion of the child run.
- `pi.durable.phase` — Durable-owned task phase spans; other `pi.durable.*` spans are also emitted by Durable.
- `durable_subagents.report.delivery` — report delivery and acknowledgement, correlated to the originating execution.

The execution span has events for user messages, assistant text responses, tool calls and results, report creation, and failed or unanswered execution. **Tool calls and results are span events, not separate span nodes.** When inspecting a trace in Phoenix, select the execution span and inspect its events. Durable's `pi.durable.submit` may appear as a separate root trace with a link to the caller rather than as a child span. Report delivery uses the trace context persisted with the report.

The HTTP trace and metric exporters use OTLP/protobuf; the gRPC exporters use OTLP/gRPC. The metric pipeline is configured alongside tracing. The extension's diagnostics are primarily traces; it does not currently define a catalog of extension-specific counters or histograms. Metrics appear when an instrumented component records measurements through the shared telemetry context.

## Payload and privacy behavior

When telemetry is enabled, exported data can include:

- Managed task text and child user messages.
- Assistant text responses (not hidden reasoning/thinking content).
- Tool names, arguments, results, and error flags.
- Report text and delivery events.

Each captured content field is capped at **64 KiB in UTF-8**. A truncated field includes a `<field>.truncated` flag and `<field>.original_size_bytes` value. Tool-call arguments are recursively redacted when object keys look credential-related (for example, `authorization`, `api_key`, `access_token`, `password`, `secret`, `credential`, or `headers`). The extension does not attach provider authentication headers to spans.

This is not a general-purpose secret scanner: task text, assistant responses, and tool output are free-form text and could themselves contain sensitive data. Use a collector you trust, and review its access controls and retention policy before opting in. The local Phoenix Compose configuration is for development only; it has authentication disabled.

## Failure behavior and shutdown

Telemetry is fail-open. Initialization and export problems produce a minimal warning; managed-agent work continues and telemetry may be lost. There is no durable telemetry spool or custom retry queue. The extension does not write detailed telemetry to a plain-text log.

The runtime shuts down the trace and metric providers when its managed session closes. No separate shutdown command is needed. Stop the local development collector with:

```sh
docker compose -f scripts/docker-compose.yml down
```

The named `phoenix-data` volume preserves collector data. Remove it only if you intend to delete that local telemetry data:

```sh
docker compose -f scripts/docker-compose.yml down --volumes
```

## Troubleshooting

- **No telemetry appears:** confirm `DURABLE_SUBAGENTS_OTLP_ENDPOINT` is set in Pi's environment before the runtime opens. Setting only `OTEL_EXPORTER_OTLP_ENDPOINT` does not opt in.
- **HTTP requests fail:** use `http/protobuf` and an OTLP/HTTP collector endpoint. The default exporter paths are `/v1/traces` and `/v1/metrics`; signal-specific endpoints must include the complete desired URL.
- **gRPC requests fail:** set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and use the collector's gRPC address (port `4317` for the supplied local Phoenix Compose file), not its HTTP/UI port.
- **Phoenix shows a trace but no tool rows in the span tree:** tool calls/results are events on `durable_subagents.execution`; inspect that span's event details.
- **Some content is incomplete:** check the field's `.truncated` and `.original_size_bytes` attributes; the per-field cap is 64 KiB.
- **Exports disappear during shutdown or collector outages:** telemetry is best-effort and not spooled for later delivery.
