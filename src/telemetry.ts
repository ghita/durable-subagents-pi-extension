import { createRequire } from "node:module";
import {
	ROOT_CONTEXT,
	SpanKind,
	SpanStatusCode,
	trace,
	type Attributes,
	type Context as OtelContext,
	type Link,
	type Span as OtelSpan,
	type SpanContext as OtelSpanContext,
	type SpanOptions as OtelSpanOptions,
	type Tracer,
} from "@opentelemetry/api";
import { TraceState } from "@opentelemetry/core";
import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as HttpProtobufMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type {
	AttributeValue,
	SpanAttributes,
	SpanLink,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetryCounter,
	TelemetryHistogram,
	TelemetryMetrics,
	TelemetryPropagation,
	TelemetrySpan,
	TelemetryUpDownCounter,
} from "@earendil-works/pi-telemetry";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
const TELEMETRY_SCOPE = "pi.durable-subagents";
const TELEMETRY_SCOPE_VERSION: string = createRequire(import.meta.url)("../package.json").version;
const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

export interface OptInTelemetry {
	readonly context: TelemetryContext;
	close(): Promise<void>;
}

export type TelemetryEnvironment = Record<string, string | undefined>;

function warnOnceFactory(warn: (message: string) => void): (message: string) => void {
	let warned = false;
	return (message) => {
		if (warned) return;
		warned = true;
		try {
			warn(message);
		} catch {
			// A diagnostic callback must never affect managed-agent work.
		}
	};
}

const warnInstrumentationFailure = warnOnceFactory((message) => console.warn(`[durable-subagents] ${message}`));

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseHeaders(...values: (string | undefined)[]): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const value of values) {
		if (value === undefined) continue;
		for (const part of value.split(",")) {
			const separator = part.indexOf("=");
			if (separator <= 0) continue;
			const key = part.slice(0, separator).trim();
			if (key === "") continue;
			try {
				headers[key] = decodeURIComponent(part.slice(separator + 1).trim());
			} catch {
				// Ignore malformed optional header values rather than failing agent startup.
			}
		}
	}
	return headers;
}

function resourceAttributes(environment: TelemetryEnvironment): Record<string, string> {
	const attributes: Record<string, string> = {
		"service.name": environment.OTEL_SERVICE_NAME?.trim() || "pi-durable-subagents",
	};
	for (const entry of (environment.OTEL_RESOURCE_ATTRIBUTES ?? "").split(",")) {
		const separator = entry.indexOf("=");
		if (separator <= 0) continue;
		const key = entry.slice(0, separator).trim();
		if (key === "") continue;
		try {
			attributes[key] = decodeURIComponent(entry.slice(separator + 1).trim());
		} catch {
			// Malformed optional resource attributes are ignored.
		}
	}
	return attributes;
}

function httpEndpoint(base: string, signal: "traces" | "metrics", specific: string | undefined): string {
	if (specific?.trim()) return specific.trim();
	return `${base.trim().replace(/\/+$/, "")}/v1/${signal}`;
}

function exporterOptions(
	environment: TelemetryEnvironment,
	baseEndpoint: string,
	signal: "traces" | "metrics",
	protocol: string,
): { url: string; headers: Record<string, string>; timeoutMillis: number } {
	const upper = signal.toUpperCase();
	const specificEndpoint = environment[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`];
	return {
		url: protocol === "grpc"
			? (specificEndpoint?.trim() || baseEndpoint.trim())
			: httpEndpoint(baseEndpoint, signal, specificEndpoint),
		headers: parseHeaders(
			environment.OTEL_EXPORTER_OTLP_HEADERS,
			environment[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`],
		),
		timeoutMillis: parsePositiveInteger(
			environment[`OTEL_EXPORTER_OTLP_${upper}_TIMEOUT`] ?? environment.OTEL_EXPORTER_OTLP_TIMEOUT,
			10_000,
		),
	};
}

function attributeMap(attributes: SpanAttributes | undefined): Attributes {
	const safe: Attributes = {};
	if (attributes === undefined) return safe;
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			safe[key] = value;
		} else if (Array.isArray(value) && value.every((item) =>
			typeof item === "string" || typeof item === "number" || typeof item === "boolean",
		)) {
			const items = [...value];
			safe[key] = typeof items[0] === "string"
				? items as string[]
				: typeof items[0] === "number" ? items as number[] : items as boolean[];
		}
	}
	return safe;
}

interface InternalTelemetryContext extends TelemetryContext {
	otelContext(): OtelContext;
	spanContext(): OtelSpanContext | undefined;
}

function toOtelLinks(links: readonly SpanLink[] | undefined): Link[] | undefined {
	if (links === undefined || links.length === 0) return undefined;
	return links.flatMap((link) => {
		const spanContext = (link.context as InternalTelemetryContext).spanContext();
		return spanContext === undefined ? [] : [{ context: spanContext, attributes: attributeMap(link.attributes) }];
	});
}

class OtelTelemetryContext implements InternalTelemetryContext {
	readonly metrics: TelemetryMetrics;
	readonly propagation: TelemetryPropagation;
	readonly #context: OtelContext;
	readonly #tracer: Tracer;

	constructor(context: OtelContext, tracer: Tracer, metrics: TelemetryMetrics, propagation: TelemetryPropagation) {
		this.#context = context;
		this.#tracer = tracer;
		this.metrics = metrics;
		this.propagation = propagation;
	}

	otelContext(): OtelContext {
		return this.#context;
	}

	spanContext(): OtelSpanContext | undefined {
		return trace.getSpanContext(this.#context);
	}

	async startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		const otelOptions: OtelSpanOptions = {
			kind: SpanKind.INTERNAL,
			attributes: attributeMap(options.attributes),
			links: toOtelLinks(options.links),
		};
		const span = this.#tracer.startSpan(options.name, otelOptions, this.#context);
		const spanContext = trace.setSpan(this.#context, span);
		const wrapped = new OtelTelemetrySpan(span, spanContext, this.#tracer, this.metrics, this.propagation);
		try {
			const result = await callback(wrapped);
			return result;
		} catch (error) {
			span.setAttribute("error.type", error instanceof Error ? error.name : typeof error);
			span.setStatus({ code: SpanStatusCode.ERROR });
			throw error;
		} finally {
			span.end();
		}
	}
}

class OtelTelemetrySpan extends OtelTelemetryContext implements TelemetrySpan {
	readonly #span: OtelSpan;
	constructor(span: OtelSpan, context: OtelContext, tracer: Tracer, metrics: TelemetryMetrics, propagation: TelemetryPropagation) {
		super(context, tracer, metrics, propagation);
		this.#span = span;
	}

	addLink(link: SpanLink): void {
		const spanContext = (link.context as InternalTelemetryContext).spanContext();
		if (spanContext !== undefined) this.#span.addLink({ context: spanContext, attributes: attributeMap(link.attributes) });
	}

	addEvent(name: string, attributes?: SpanAttributes): void {
		this.#span.addEvent(name, attributeMap(attributes));
	}

	setAttributes(attributes: SpanAttributes): void {
		this.#span.setAttributes(attributeMap(attributes));
	}

	setStatus(status: SpanStatus): void {
		this.#span.setStatus({ code: status.status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
	}
}

function createPropagation(tracer: Tracer, metrics: TelemetryMetrics): TelemetryPropagation {
	const propagation: TelemetryPropagation = {
		inject(context) {
			const spanContext = (context as InternalTelemetryContext).spanContext();
			if (spanContext === undefined || /^0+$/.test(spanContext.traceId) || /^0+$/.test(spanContext.spanId)) return undefined;
			const carrier: Record<string, string> = {
				traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, "0")}`,
			};
			const traceState = spanContext.traceState?.serialize();
			if (traceState) carrier.tracestate = traceState;
			return carrier;
		},
		extract(carrier) {
			if (carrier === undefined) return new OtelTelemetryContext(ROOT_CONTEXT, tracer, metrics, propagation);
			const match = TRACEPARENT.exec(carrier.traceparent ?? "");
			if (match === null || /^0+$/.test(match[2]!) || /^0+$/.test(match[3]!)) {
				return new OtelTelemetryContext(ROOT_CONTEXT, tracer, metrics, propagation);
			}
			const spanContext: OtelSpanContext = {
				traceId: match[2]!,
				spanId: match[3]!,
				traceFlags: Number.parseInt(match[4]!, 16),
				isRemote: true,
				...(carrier.tracestate === undefined ? {} : { traceState: new TraceState(carrier.tracestate) }),
			};
			return new OtelTelemetryContext(trace.setSpanContext(ROOT_CONTEXT, spanContext), tracer, metrics, propagation);
		},
	};
	return propagation;
}

function createTelemetryMetrics(meter: ReturnType<MeterProvider["getMeter"]>): TelemetryMetrics {
	const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
	const upDownCounters = new Map<string, ReturnType<typeof meter.createUpDownCounter>>();
	const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();
	const counter = (name: string, options?: { description?: string; unit?: string }): TelemetryCounter => {
		let instrument = counters.get(name);
		if (instrument === undefined) {
			instrument = meter.createCounter(name, options);
			counters.set(name, instrument);
		}
		return { add: (value, attributes) => instrument!.add(value, attributeMap(attributes)) };
	};
	const upDownCounter = (name: string, options?: { description?: string; unit?: string }): TelemetryUpDownCounter => {
		let instrument = upDownCounters.get(name);
		if (instrument === undefined) {
			instrument = meter.createUpDownCounter(name, options);
			upDownCounters.set(name, instrument);
		}
		return { add: (value, attributes) => instrument!.add(value, attributeMap(attributes)) };
	};
	const histogram = (
		name: string,
		options?: { description?: string; unit?: string; boundaries?: readonly number[] },
	): TelemetryHistogram => {
		let instrument = histograms.get(name);
		if (instrument === undefined) {
			instrument = meter.createHistogram(name, {
				description: options?.description,
				unit: options?.unit,
				...(options?.boundaries === undefined ? {} : { advice: { explicitBucketBoundaries: [...options.boundaries] } }),
			});
			histograms.set(name, instrument);
		}
		return { record: (value, attributes) => instrument!.record(value, attributeMap(attributes)) };
	};
	return { counter, upDownCounter, histogram };
}

function observeSpanExporter(exporter: SpanExporter, onError: () => void): SpanExporter {
	return {
		export(spans, callback) {
			try {
				exporter.export(spans, (result) => {
					if (result.code !== 0) onError();
					callback(result);
				});
			} catch {
				onError();
				callback({ code: 1 });
			}
		},
		shutdown: () => exporter.shutdown(),
	};
}

function observeMetricExporter<T extends PushMetricExporter>(exporter: T, onError: () => void): T {
	return new Proxy(exporter, {
		get(target, property) {
			if (property === "export") {
				return (metrics: Parameters<T["export"]>[0], callback: Parameters<T["export"]>[1]) => {
					try {
						target.export(metrics, (result) => {
							if (result.code !== 0) onError();
							callback(result);
						});
					} catch {
						onError();
						callback({ code: 1 });
					}
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Returns no adapter unless the extension-specific endpoint explicitly opts in. */
export function createOptInTelemetry(
	environment: TelemetryEnvironment = process.env,
	warn: (message: string) => void = (message) => console.warn(`[durable-subagents] ${message}`),
): OptInTelemetry | undefined {
	const endpoint = environment.DURABLE_SUBAGENTS_OTLP_ENDPOINT?.trim();
	if (!endpoint) return undefined;

	const reportWarning = warnOnceFactory(warn);
	const protocol = (environment.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf").trim().toLowerCase();
	if (protocol !== "http/protobuf" && protocol !== "grpc") {
		reportWarning("OpenTelemetry disabled: OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf or grpc.");
		return undefined;
	}

	let traceExporter: SpanExporter | undefined;
	let metricExporter: InstanceType<typeof HttpProtobufMetricExporter> | InstanceType<typeof GrpcMetricExporter> | undefined;
	try {
		const traceOptions = exporterOptions(environment, endpoint, "traces", protocol);
		const metricOptions = exporterOptions(environment, endpoint, "metrics", protocol);
		if (protocol === "grpc") {
			traceExporter = new GrpcTraceExporter(traceOptions);
			metricExporter = new GrpcMetricExporter(metricOptions);
		} else {
			traceExporter = new HttpProtobufTraceExporter(traceOptions);
			metricExporter = new HttpProtobufMetricExporter(metricOptions);
		}

		const resource = new Resource(resourceAttributes(environment));
		const traceProvider = new BasicTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(
				observeSpanExporter(traceExporter, () => reportWarning("OpenTelemetry trace export failed; managed-agent work continues.")),
				{ exportTimeoutMillis: traceOptions.timeoutMillis },
			)],
		});
		const observedMetricExporter = observeMetricExporter(
			metricExporter,
			() => reportWarning("OpenTelemetry metric export failed; managed-agent work continues."),
		);
		const metricReader = new PeriodicExportingMetricReader({
			exporter: observedMetricExporter,
			exportIntervalMillis: parsePositiveInteger(environment.OTEL_METRIC_EXPORT_INTERVAL, 60_000),
			exportTimeoutMillis: metricOptions.timeoutMillis,
		});
		const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
		const tracer = traceProvider.getTracer(TELEMETRY_SCOPE, TELEMETRY_SCOPE_VERSION);
		const metrics = createTelemetryMetrics(meterProvider.getMeter(TELEMETRY_SCOPE, TELEMETRY_SCOPE_VERSION));
		const propagation = createPropagation(tracer, metrics);
		const context = new OtelTelemetryContext(ROOT_CONTEXT, tracer, metrics, propagation);
		let closed = false;
		return {
			context,
			async close() {
				if (closed) return;
				closed = true;
				try {
					await Promise.all([traceProvider.shutdown(), meterProvider.shutdown()]);
				} catch {
					reportWarning("OpenTelemetry shutdown/flush failed; some telemetry may be lost.");
				}
			},
		};
	} catch {
		try {
			void traceExporter?.shutdown();
			void metricExporter?.shutdown();
		} catch {
			// Best-effort cleanup after failed setup.
		}
		reportWarning("OpenTelemetry setup failed; export is disabled and managed-agent work continues.");
		return undefined;
	}
}

export interface CappedContent {
	value: string;
	truncated: boolean;
	originalSizeBytes: number;
}

export function capContent(value: string, maxBytes = MAX_PAYLOAD_BYTES): CappedContent {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return { value, truncated: false, originalSizeBytes: bytes.byteLength };
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--;
	return {
		value: bytes.subarray(0, end).toString("utf8"),
		truncated: true,
		originalSizeBytes: bytes.byteLength,
	};
}

export function cappedContentAttributes(key: string, value: string): SpanAttributes {
	const capped = capContent(value);
	return {
		[key]: capped.value,
		[`${key}.truncated`]: capped.truncated,
		...(capped.truncated ? { [`${key}.original_size_bytes`]: capped.originalSizeBytes } : {}),
	};
}

/** A span wrapper that treats adapter exceptions as telemetry loss, never as agent failure. */
export async function inTelemetrySpan<T>(
	context: TelemetryContext | undefined,
	options: SpanOptions,
	work: (span: TelemetrySpan | undefined) => T | Promise<T>,
	warn: (message: string) => void = warnInstrumentationFailure,
): Promise<T> {
	if (context === undefined) return work(undefined);
	let callbackStarted = false;
	let workResult: T | undefined;
	let resultReady = false;
	let workFailed = false;
	let workFailure: unknown;
	try {
		return await context.startSpan(options, async (span) => {
			callbackStarted = true;
			try {
				workResult = await work(span);
				resultReady = true;
				return workResult;
			} catch (error) {
				workFailed = true;
				workFailure = error;
				throw error;
			}
		});
	} catch (error) {
		if (workFailed) throw workFailure;
		if (callbackStarted && resultReady) return workResult as T;
		try {
			warn("OpenTelemetry instrumentation failed; managed-agent work continues.");
		} catch {
			// Warning handlers are best effort.
		}
		return work(undefined);
	}
}

export function safeAddEvent(
	span: TelemetrySpan | undefined,
	name: string,
	attributes?: SpanAttributes,
	warn: (message: string) => void = warnInstrumentationFailure,
): void {
	if (span === undefined) return;
	try {
		span.addEvent(name, attributes);
	} catch {
		try {
			warn("OpenTelemetry instrumentation failed; managed-agent work continues.");
		} catch {
			// Warning handlers are best effort.
		}
	}
}

/** Extract a carrier to parent a later extension-owned span; invalid/missing carriers safely use the root. */
export function extractTelemetryContext(
	context: TelemetryContext | undefined,
	carrier: Record<string, string> | undefined,
): TelemetryContext | undefined {
	if (context?.propagation === undefined) return undefined;
	try {
		return context.propagation.extract(carrier);
	} catch {
		return context;
	}
}

export function injectTelemetryContext(span: TelemetrySpan | undefined): Record<string, string> | undefined {
	if (span?.propagation === undefined) return undefined;
	try {
		return span.propagation.inject(span);
	} catch {
		return undefined;
	}
}
