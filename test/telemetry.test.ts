import { createServer } from "node:http";
import otlpProto from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverPiReportWithTelemetry } from "../src/report-delivery.ts";
import { cappedContentAttributes, capContent, createOptInTelemetry, inTelemetrySpan, MAX_PAYLOAD_BYTES } from "../src/telemetry.ts";

interface ProtoRequestDecoder<T> {
	decode(data: Uint8Array): T;
}

interface DecodedTraceRequest {
	resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ name?: string }> }> }>;
}

interface DecodedMetricsRequest {
	resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: Array<{ name?: string }> }> }>;
}

const protoRoot = otlpProto as unknown as {
	opentelemetry: {
		proto: {
			collector: {
				trace: { v1: { ExportTraceServiceRequest: ProtoRequestDecoder<DecodedTraceRequest> } };
				metrics: { v1: { ExportMetricsServiceRequest: ProtoRequestDecoder<DecodedMetricsRequest> } };
			};
		};
	};
};

const openTelemetryAdapters: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	await Promise.all(openTelemetryAdapters.splice(0).map((adapter) => adapter.close()));
});

describe("opt-in OpenTelemetry", () => {
	it("does not create an exporter when the extension endpoint is absent", () => {
		const warn = vi.fn();
		expect(createOptInTelemetry({}, warn)).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	it("caps by UTF-8 bytes without returning a partial code point", () => {
		const capped = capContent(`x${"🙂".repeat(3)}`, 6);
		expect(capped).toEqual({ value: "x🙂", truncated: true, originalSizeBytes: 13 });
		expect(Buffer.byteLength(capped.value, "utf8")).toBeLessThanOrEqual(6);
	});

	it("records truncation and original UTF-8 size at the 64 KiB payload cap", () => {
		const attributes = cappedContentAttributes("content", "x".repeat(MAX_PAYLOAD_BYTES + 1));
		expect(Buffer.byteLength(String(attributes.content), "utf8")).toBe(MAX_PAYLOAD_BYTES);
		expect(attributes["content.truncated"]).toBe(true);
		expect(attributes["content.original_size_bytes"]).toBe(MAX_PAYLOAD_BYTES + 1);
	});

	it("runs work exactly once when instrumentation setup throws", async () => {
		const warn = vi.fn();
		const work = vi.fn(async () => "done");
		const context = { startSpan: async () => { throw new Error("exporter unavailable"); } } as never;

		await expect(inTelemetrySpan(context, { name: "test" }, work, warn)).resolves.toBe("done");
		expect(work).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("does not swallow work failures while preserving fail-open instrumentation", async () => {
		const warn = vi.fn();
		const context = { startSpan: async (_options: unknown, callback: (span: any) => unknown) => callback({}) } as never;
		const failure = new Error("managed action failed");
		const work = vi.fn(() => { throw failure; });

		await expect(inTelemetrySpan(context, { name: "test" }, work, warn)).rejects.toBe(failure);
		expect(work).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
	});

	it("parents report delivery to the originating managed-agent trace", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let traceContext: Record<string, string> | undefined;
		await telemetry.startSpan({ name: "durable_subagents.execution" }, async (span) => {
			traceContext = telemetry.propagation!.inject(span);
		});
		const sent: unknown[] = [];
		const acknowledge = vi.fn(async () => undefined);

		const result = await deliverPiReportWithTelemetry(
			{ id: "report-1", agentName: "worker", text: "The result.", traceContext },
			telemetry,
			{
				getEntries: () => [],
				sendMessage: (message) => { sent.push(message); },
				waitForRecorded: async () => true,
			},
			acknowledge,
		);

		const spans = telemetry.getSpans();
		const origin = spans.find((span) => span.name === "durable_subagents.execution");
		const delivery = spans.find((span) => span.name === "durable_subagents.report.delivery");
		expect(result).toEqual({ deliveredNow: true, acknowledged: true });
		expect(sent).toHaveLength(1);
		expect(acknowledge).toHaveBeenCalledWith("report-1");
		expect(delivery?.context["pi-memory-trace"]).toBe(origin?.context["pi-memory-trace"]);
		expect(delivery?.events.map((event) => event.name)).toEqual([
			"managed_agent.report.delivery_started",
			"managed_agent.report.delivery_completed",
		]);
	});

	it("exports correlated traces and metrics through configured OTLP/HTTP settings", async () => {
		const requests: Array<{
			path: string;
			header: string | undefined;
			contentType: string | undefined;
			body: Buffer;
		}> = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); });
			request.on("end", () => {
				requests.push({
					path: request.url ?? "",
					header: request.headers["x-test-header"] as string | undefined,
					contentType: request.headers["content-type"],
					body: Buffer.concat(chunks),
				});
				response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Test OTLP server did not bind a TCP port.");
		const warn = vi.fn();
		const telemetry = createOptInTelemetry({
			DURABLE_SUBAGENTS_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
			OTEL_EXPORTER_OTLP_HEADERS: "x-test-header=collector%20token",
			OTEL_METRIC_EXPORT_INTERVAL: "60000",
		}, warn);
		if (telemetry === undefined) throw new Error("Expected opt-in telemetry adapter.");
		openTelemetryAdapters.push(telemetry);

		try {
			await telemetry.context.startSpan({ name: "managed_agent.test" }, async (span) => {
				span.addEvent("managed_agent.payload", { text: "private test payload" });
			});
			telemetry.context.metrics!.counter("managed_agent.test.count").add(1);
			await telemetry.close();

			const paths = requests.map(({ path }) => path);
			expect(paths).toContain("/v1/traces");
			expect(paths).toContain("/v1/metrics");
			expect(paths.every((path) => path === "/v1/traces" || path === "/v1/metrics")).toBe(true);
			expect(requests.every(({ header }) => header === "collector token")).toBe(true);
			expect(requests.every(({ body }) => body.byteLength > 0)).toBe(true);

			const traceRequest = requests.find(({ path }) => path === "/v1/traces");
			expect(traceRequest?.contentType).toBe("application/x-protobuf");
			const tracePayload = protoRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.decode(traceRequest!.body);
			const spanNames = tracePayload.resourceSpans?.flatMap((resource) =>
				resource.scopeSpans?.flatMap((scope) => scope.spans?.map((span) => span.name) ?? []) ?? [],
			) ?? [];
			expect(spanNames).toContain("managed_agent.test");

			const metricRequest = requests.find(({ path }) => path === "/v1/metrics");
			expect(metricRequest?.contentType).toBe("application/x-protobuf");
			const metricPayload = protoRoot.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest.decode(metricRequest!.body);
			const metricNames = metricPayload.resourceMetrics?.flatMap((resource) =>
				resource.scopeMetrics?.flatMap((scope) => scope.metrics?.map((metric) => metric.name) ?? []) ?? [],
			) ?? [];
			expect(metricNames).toContain("managed_agent.test.count");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});
