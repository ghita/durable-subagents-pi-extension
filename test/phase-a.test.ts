import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createPiModelBridge } from "../src/model-bridge.ts";
import {
	deliverPiReport,
	hasPiReportEntry,
	SUBAGENT_REPORT_TYPE,
	type ManagedReport,
	type PiReportMessage,
	type ReportEntryLike,
} from "../src/report-delivery.ts";

const model = {
	id: "test-model",
	provider: "github-copilot",
	api: "openai-responses",
	baseUrl: "https://example.invalid",
	name: "Test model",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 16_000,
	maxTokens: 1_000,
} as Model<"openai-responses">;

const answer = {
	role: "assistant",
	content: [{ type: "text", text: "bridge works" }],
	api: "openai-responses",
	provider: "github-copilot",
	model: model.id,
	usage: { input: 1, output: 2, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: Date.now(),
} as AssistantMessage;

describe("Phase A model bridge", () => {
	it("forwards model lookup and streaming to Pi's registry without owning credentials", async () => {
		const requestContext = { messages: [] } as never;
		const requestOptions = { signal: new AbortController().signal };
		const stream = { result: vi.fn().mockResolvedValue(answer) } as unknown as {
			result(): Promise<AssistantMessage>;
		};
		const registry = {
			find: vi.fn().mockReturnValue(model),
			streamSimple: vi.fn().mockReturnValue(stream),
		} as unknown as ModelRegistry;

		const bridge = createPiModelBridge(registry);

		expect(bridge.getModel("github-copilot", model.id)).toBe(model);
		await expect(bridge.completeSimple(model, requestContext, requestOptions)).resolves.toBe(answer);
		expect(registry.find).toHaveBeenCalledWith("github-copilot", model.id);
		expect(registry.streamSimple).toHaveBeenCalledWith(model, requestContext, requestOptions);
		expect(stream.result).toHaveBeenCalledOnce();
	});

	it("fails explicitly rather than inventing a deferred-response credential path", async () => {
		const registry = {
			getRegisteredProviderIds: () => [],
			getProvider: () => undefined,
			getAll: () => [],
			getAvailable: () => [],
			find: () => undefined,
			getModelsOfType: () => [],
			getAvailableOfType: async () => [],
			getModelOfType: () => undefined,
			refresh: async () => ({ aborted: false, errors: new Map() }),
			getProviderAuth: async () => undefined,
			stream: vi.fn(),
			complete: vi.fn(),
			streamSimple: vi.fn(),
			generateImages: vi.fn(),
			classify: vi.fn(),
		} as unknown as ModelRegistry;
		const bridge = createPiModelBridge(registry);

		await expect(bridge.fetchDeferred(model, {} as never)).rejects.toThrow(/public ModelRegistry/);
	});
});

describe("Phase A Pi report delivery spike", () => {
	const report: ManagedReport = {
		id: "subagent-report:task-42",
		agentName: "researcher",
		text: "Findings are ready.",
	};

	function makeTransport() {
		const entries: ReportEntryLike[] = [];
		const sent: PiReportMessage[] = [];
		const transport = {
			getEntries: () => [...entries],
			sendMessage: vi.fn((message: PiReportMessage) => {
				sent.push(message);
				// Simulate Pi appending the extension-authored custom message to its transcript.
				entries.push({ type: "custom_message", customType: message.customType, details: message.details });
			}),
			waitForRecorded: async (id: string) => hasPiReportEntry(entries, id),
		};
		return { entries, sent, transport };
	}

	it("steers a custom report into the main turn and starts a turn when idle", async () => {
		const { sent, transport } = makeTransport();
		const acknowledge = vi.fn(async () => {});

		await expect(deliverPiReport(report, transport, acknowledge)).resolves.toEqual({ deliveredNow: true, acknowledged: true });
		expect(transport.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: SUBAGENT_REPORT_TYPE,
				content: expect.stringContaining("Subagent researcher report"),
				details: { reportId: report.id, agentName: report.agentName },
			}),
			{ triggerTurn: true, deliverAs: "steer" },
		);
		expect(sent).toHaveLength(1);
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(report.id);
	});

	it("recovers after Pi persisted the report but Durable had not acknowledged it", async () => {
		const { sent, transport } = makeTransport();
		let acknowledged = 0;

		await expect(
			deliverPiReport(report, transport, async () => {
				throw new Error("simulated process loss before the durable acknowledgment");
			}),
		).rejects.toThrow(/simulated process loss/);
		expect(sent).toHaveLength(1);

		const recovered = await deliverPiReport(report, transport, async (id) => {
			expect(id).toBe(report.id);
			acknowledged += 1;
		});

		expect(recovered).toEqual({ deliveredNow: false, acknowledged: true });
		expect(sent).toHaveLength(1);
		expect(acknowledged).toBe(1);
	});

	it("does not count a queued steering report until Pi records it in the transcript", async () => {
		const entries: ReportEntryLike[] = [];
		const sendMessage = vi.fn();
		let release!: (recorded: boolean) => void;
		const transport = {
			getEntries: () => [...entries],
			sendMessage,
			waitForRecorded: () => new Promise<boolean>((resolve) => (release = resolve)),
		};
		const acknowledge = vi.fn(async () => {});
		const delivery = deliverPiReport(report, transport, acknowledge);
		await Promise.resolve();
		await Promise.resolve();
		expect(sendMessage).toHaveBeenCalledOnce();
		expect(acknowledge).not.toHaveBeenCalled();

		entries.push({
			type: "custom_message",
			customType: SUBAGENT_REPORT_TYPE,
			details: { reportId: report.id, agentName: report.agentName },
		});
		release(true);
		await expect(delivery).resolves.toEqual({ deliveredNow: true, acknowledged: true });
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(report.id);
	});

	it("leaves a report pending if shutdown interrupts the queued Pi message", async () => {
		const { transport } = makeTransport();
		transport.waitForRecorded = async () => false;
		const acknowledge = vi.fn(async () => {});

		await expect(deliverPiReport(report, transport, acknowledge)).resolves.toEqual({
			deliveredNow: true,
			acknowledged: false,
		});
		expect(acknowledge).not.toHaveBeenCalled();
	});
});
