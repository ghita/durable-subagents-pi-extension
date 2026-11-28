import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AgentDoc,
	AssistantEntry,
	createRegistry,
	defineTask,
	LiveDoc,
	UserEntry,
	Harness,
	type ModelRef,
	UsageDoc,
	type Extension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { InMemoryTelemetryContext, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.ts";
import type { AgentPreset, PresetCatalog } from "../src/presets.ts";
import { SubagentsDoc } from "../src/agent-state.ts";
import { SubagentTasksExtension } from "../src/tasks.ts";

const directories: string[] = [];
const openHarnesses: Harness[] = [];
const codemodeSandboxes: CodemodeSandbox[] = [];

afterEach(async () => {
	await Promise.all(openHarnesses.splice(0).map((harness) => harness.close(BACKGROUND_CONTEXT)));
	await Promise.all(codemodeSandboxes.splice(0).map((sandbox) => sandbox.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(
	responses: string[],
	tokensPerSecond = 100_000,
	presets: PresetCatalog = { entries: new Map(), valid: new Map() },
	telemetry?: TelemetryContext,
	codemodeExtension?: Extension,
) {
	const directory = await mkdtemp(join(tmpdir(), "durable-subagents-integration-"));
	directories.push(directory);
	const faux = fauxProvider({
		tokensPerSecond,
		tokenSize: { min: 1, max: 1 },
		models: [{ id: "faux-parent" }, { id: "faux-pinned" }],
	});
	faux.setResponses(responses.map((text) => fauxAssistantMessage(text)));
	const models = createModels();
	models.setProvider(faux.provider);
	const durableRegistry = createRegistry();
	durableRegistry.install(CodingTools);
	if (codemodeExtension !== undefined) durableRegistry.install(codemodeExtension);
	durableRegistry.install(SubagentTasksExtension);
	const cwd = process.cwd();
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
		models,
		registry: durableRegistry,
		...(telemetry === undefined ? {} : { telemetry }),
		settings: { extensions: [CodingTools] },
		env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
	}, BACKGROUND_CONTEXT);
	openHarnesses.push(harness);
	const model = faux.getModel();
	const parentModel: ModelRef = { provider: model.provider, modelId: model.id };
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: parentModel, thinkingLevel: "off", extensions: [CodingTools] },
	});
	await root.commit(async (tx) => {
		await tx.doc(SubagentsDoc, root.id);
	}, BACKGROUND_CONTEXT);
	const modelRegistry = {
		find: vi.fn((provider: string, modelId: string) =>
			provider === model.provider ? faux.getModel(modelId) : undefined,
		),
		hasConfiguredAuth: vi.fn(() => true),
	} as unknown as ModelRegistry;
	const service = new AgentService({
		harness,
		root,
		cwd,
		presets,
		modelRegistry,
		parentModel,
		parentThinking: "off",
		telemetry,
		codemodeExtension,
	});
	harness.resume();
	return { service, harness, root, modelRegistry, model, directory, faux, models, durableRegistry, cwd, parentModel, presets };
}

describe("AgentService durable lifecycle", () => {
	it("persists the per-root pane creation guard and keeps unchanged reads/writes silent", async () => {
		const { service, harness, root } = await setup([]);
		expect(await service.herdrPaneCreationPending()).toBe(false);
		await root.commit(async (tx) => {
			const state = await tx.doc(SubagentsDoc, root.id);
			delete state["herdrPaneCreationPending" as string];
		}, BACKGROUND_CONTEXT);
		expect(await service.herdrPaneCreationPending()).toBe(false);
		await root.commit(async (tx) => {
			(await tx.doc(SubagentsDoc, root.id)).herdrPaneCreationPending = null;
		}, BACKGROUND_CONTEXT);
		expect(await service.herdrPaneCreationPending()).toBe(false);
		await service.setHerdrPaneCreationPending(true);
		expect(await service.herdrPaneCreationPending()).toBe(true);
		await expect(harness.snapshot(SubagentsDoc, root.id, BACKGROUND_CONTEXT))
			.resolves.toMatchObject({ herdrPaneCreationPending: true });
		const advance = vi.fn();
		const observation = await harness.observeDoc(SubagentsDoc, root.id, { advance, end: () => undefined }, BACKGROUND_CONTEXT);
		try {
			for (let index = 0; index < 3; index++) {
				expect(await service.herdrPaneCreationPending()).toBe(true);
				await service.setHerdrPaneCreationPending(true);
				await service.herdrDisplayAgents();
			}
			expect(advance).not.toHaveBeenCalled();
			await service.setHerdrPaneCreationPending(false);
			expect(await service.herdrPaneCreationPending()).toBe(false);
			expect(advance).toHaveBeenCalledTimes(1);
			await service.setHerdrPaneCreationPending(false);
			expect(advance).toHaveBeenCalledTimes(1);
		} finally {
			observation?.detach();
		}
	});

	it("atomically completes pane creation with its target and resets output versions only on reassignment", async () => {
		const { service, harness, root } = await setup(["Done."]);
		const spawned = await service.spawn("pane-owner", undefined, "Finish.");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);
		await service.setHerdrPaneCreationPending(true);
		await service.setHerdrOutputVersion("pane-owner", 17);
		const target = { tabId: "tab", paneId: "first-pane" };
		const observed: unknown[] = [];
		const observation = await harness.observeDoc(SubagentsDoc, root.id, {
			advance: (call) => { if (call.kind === "value") observed.push(call.value); },
			end: () => undefined,
		}, BACKGROUND_CONTEXT);
		try {
			await service.setHerdrTarget("pane-owner", target, true);
			expect(observed).toHaveLength(1);
			expect(observed[0]).toMatchObject({
				herdrPaneCreationPending: false,
				agents: { "pane-owner": { herdrTarget: target, herdrOutputVersion: null } },
			});
		} finally {
			observation?.detach();
		}
		await service.setHerdrOutputVersion("pane-owner", 18);
		await service.setHerdrTarget("pane-owner", { ...target });
		expect(await service.herdrOutputVersion("pane-owner")).toBe(18);
		await service.setHerdrPaneCreationPending(true);
		await service.setHerdrTarget("pane-owner", { tabId: "tab", paneId: "replacement-pane" });
		expect(await service.herdrOutputVersion("pane-owner")).toBeUndefined();
		expect(await service.herdrPaneCreationPending()).toBe(true);
		await service.setHerdrOutputVersion("pane-owner", 19);
		await service.setHerdrTarget("pane-owner", { tabId: "moved-tab", paneId: "replacement-pane" });
		expect(await service.herdrOutputVersion("pane-owner")).toBeUndefined();
		await service.setHerdrTarget("pane-owner", undefined, true);
		expect(await service.herdrPaneCreationPending()).toBe(true);
		await expect(service.setHerdrTarget("missing-agent", target, true)).rejects.toThrow(/No managed agent/);
		expect(await service.herdrPaneCreationPending()).toBe(true);
	});

	it("orders new work by durable acceptance rather than registry insertion and leaves unchanged polls silent", async () => {
		const { service, harness, root, faux } = await setup(["Initial first.", "Initial second."]);
		const first = await service.spawn("first-registered", undefined, "Initial task.");
		await harness.waitForTask(first.reporterTaskId, BACKGROUND_CONTEXT);
		const second = await service.spawn("second-registered", undefined, "Initial task.");
		await harness.waitForTask(second.reporterTaskId, BACKGROUND_CONTEXT);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 2" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 2" }), { stopReason: "toolUse" }),
		]);
		const secondWork = await service.send("second-registered", "Accepted first.");
		const firstWork = await service.send("first-registered", "Accepted second.");
		const summaries = await service.herdrDisplayAgents();
		expect(summaries.map(({ name }) => name)).toEqual(["first-registered", "second-registered"]);
		expect(summaries.map(({ workOrder }) => workOrder)).toEqual([firstWork.reporterTaskId, secondWork.reporterTaskId]);
		expect([...summaries].sort((a, b) => a.workOrder - b.workOrder).map(({ name }) => name))
			.toEqual(["second-registered", "first-registered"]);
		await vi.waitFor(async () => {
			expect((await service.herdrDisplayAgents()).every(({ workStart }) => workStart !== undefined)).toBe(true);
		});
		const advance = vi.fn();
		const observation = await harness.observeDoc(SubagentsDoc, root.id, { advance, end: () => undefined }, BACKGROUND_CONTEXT);
		try {
			for (let index = 0; index < 3; index++) await service.herdrDisplayAgents();
			expect(advance).not.toHaveBeenCalled();
		} finally {
			observation?.detach();
		}
		await service.stopAll();
	});

	it("tracks undisplayed queued work, multiple steers, replay periods, and report-only idle", async () => {
		const { service, harness, root, faux } = await setup([], 100_000);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1; printf ready" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done with the shared work."),
		]);
		const first = await service.spawn("display-worker", undefined, "Begin work.");
		const accepted = (await service.herdrDisplayAgents())[0]!;
		expect(accepted).toMatchObject({ name: "display-worker", conversationId: first.conversationId, active: true });
		expect(accepted.workKey).toEqual(expect.any(String));
		expect(await service.herdrAgents()).toEqual([]);
		const child = (await harness.conversation(first.conversationId, BACKGROUND_CONTEXT))!;
		await vi.waitFor(async () => {
			const live = await harness.snapshot(LiveDoc, child.id, BACKGROUND_CONTEXT);
			expect(live?.tools?.length).toBe(1);
		});
		const running = (await service.herdrDisplayAgents())[0]!;
		const inputs = (await child.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.filter(UserEntry.is);
		expect(running.workStart).toBe(inputs[0]!.id);
		expect(running.workKey).toBe(accepted.workKey);
		expect(running.workOrder).toBe(first.reporterTaskId);

		const steers = await Promise.all([
			service.send("display-worker", "First steer."),
			service.send("display-worker", "Second steer."),
		]);
		expect((await service.herdrDisplayAgents())[0]).toEqual(running);
		await Promise.all([first, ...steers].map(({ reporterTaskId }) => harness.waitForTask(reporterTaskId, BACKGROUND_CONTEXT)));
		expect(await service.pendingReports()).toHaveLength(3);
		expect((await service.herdrDisplayAgents())[0]).toEqual({ ...running, active: false });

		faux.setResponses([fauxAssistantMessage("x".repeat(500))]);
		const next = await service.send("display-worker", "A new work period.");
		await vi.waitFor(async () => {
			const summary = (await service.herdrDisplayAgents())[0]!;
			expect(summary.workKey).not.toBe(running.workKey);
			expect(summary.workStart).toBeGreaterThan(running.workStart!);
		});
		await service.stop("display-worker");
		await harness.waitForTask(next.reporterTaskId, BACKGROUND_CONTEXT);
		expect((await service.herdrDisplayAgents())[0]?.active).toBe(false);
		await expect(harness.snapshot(SubagentsDoc, root.id, BACKGROUND_CONTEXT)).resolves.toMatchObject({
			agents: { "display-worker": { workReporterTaskIds: [next.reporterTaskId] } },
		});
	}, 10_000);

	it("migrates active legacy markers from the run, then retains them after stop", async () => {
		const { service, harness, root } = await setup(["x".repeat(500)], 1);
		const spawned = await service.spawn("legacy-display", undefined, "Legacy running work.");
		await vi.waitFor(async () => expect((await service.status("legacy-display")).active).toBe(true));
		const live = await harness.snapshot(LiveDoc, spawned.conversationId, BACKGROUND_CONTEXT);
		await root.commit(async (tx) => {
			const agent = (await tx.doc(SubagentsDoc, root.id)).agents["legacy-display"]!;
			for (const field of ["workKey", "workStart", "workReporterTaskIds"]) delete agent[field];
		}, BACKGROUND_CONTEXT);
		const migrated = (await service.herdrDisplayAgents())[0]!;
		expect(migrated).toMatchObject({ active: true, workStart: live!.run!.first });
		expect(migrated.workKey).toMatch(/^legacy:/);
		expect(migrated.workOrder).toBe(spawned.reporterTaskId);
		expect((await service.herdrDisplayAgents())[0]).toEqual(migrated);
		await service.stop("legacy-display");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);
		expect((await service.herdrDisplayAgents())[0]).toEqual({ ...migrated, active: false });
	});

	it("does not mistake a live report-only task for queued input, and clears pane metadata", async () => {
		const { service, harness, root, durableRegistry } = await setup(["Finished."]);
		const spawned = await service.spawn("report-only", undefined, "Finish this request.");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);
		const original = (await harness.getTask(spawned.reporterTaskId, BACKGROUND_CONTEXT))!;
		// Simulate a reporter paused after submission settlement but before its terminal commit.
		const WaitingReporter = defineTask<typeof original.input, { phase: "wait" }, null>({
			name: "test.report-only",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: { wait: (_task, runtime, context) => runtime.commit(() => ({
				status: "sleeping", until: Date.now() + 60_000, checkpoint: { phase: "wait" },
			}), context) },
			abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		});
		durableRegistry.install({ name: "test.report-only", tasks: [WaitingReporter] });
		await root.commit(async (tx) => {
			const state = await tx.doc(SubagentsDoc, root.id);
			const taskId = await tx.createTask(WaitingReporter, original.input, { ownership: { kind: "conversation" }, background: true });
			state.agents["report-only"]!.workReporterTaskIds!.push(taskId);
			state.agents["report-only"]!.reporterTaskIds.push(taskId);
		}, BACKGROUND_CONTEXT);
		expect((await service.herdrDisplayAgents())[0]?.active).toBe(false);
		expect(await service.pendingReports()).toHaveLength(1);
		await service.setHerdrTarget("report-only", { tabId: "tab", paneId: "pane" });
		await service.setHerdrOutputVersion("report-only", 42);
		await service.setHerdrTarget("report-only", undefined);
		expect(await service.herdrTarget("report-only")).toBeUndefined();
		expect(await service.herdrOutputVersion("report-only")).toBeUndefined();
		expect(await service.herdrAgents()).toEqual([]);
		expect(await service.herdrDisplayAgents()).toHaveLength(1);

		// An accepted request still waiting to submit is eligible even with no child run.
		const queuedTaskId = await root.commit(async (tx) => {
			const state = await tx.doc(SubagentsDoc, root.id);
			const taskId = await tx.createTask(WaitingReporter, { requestId: "not-submitted-yet" }, {
				ownership: { kind: "conversation" }, background: true,
			});
			state.agents["report-only"]!.workReporterTaskIds!.push(taskId);
			return taskId;
		}, BACKGROUND_CONTEXT);
		expect((await service.herdrDisplayAgents())[0]?.active).toBe(true);
		await harness.abortTask(queuedTaskId, BACKGROUND_CONTEXT);
		await harness.waitForTask(queuedTaskId, BACKGROUND_CONTEXT);
		expect((await service.herdrDisplayAgents())[0]?.active).toBe(false);
	});

	it("captures request-local tool activity when a child submission ends unanswered", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { service, harness, faux, directory } = await setup([], 100_000, { entries: new Map(), valid: new Map() }, telemetry);
		const file = join(directory, "partial-tool-output.txt");
		await writeFile(file, "tool output before model failure", "utf8");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: file }), { stopReason: "toolUse" }),
			fauxAssistantMessage("synthetic provider failure", { stopReason: "error", errorMessage: "synthetic provider failure" }),
		]);

		const spawned = await service.spawn("failing-worker", undefined, "Read the file, then summarize it.");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);
		expect((await service.herdrDisplayAgents())[0]).toMatchObject({ active: false, workStart: expect.any(Number) });

		const executionSpan = telemetry.getSpans().find((span) =>
			span.name === "durable_subagents.execution"
			&& span.attributes["managed_agent.task.text"] === "Read the file, then summarize it.",
		);
		const events = executionSpan?.events ?? [];
		expect(events.map((event) => event.name)).toEqual([
			"managed_agent.user_message",
			"managed_agent.tool_call",
			"managed_agent.tool_result",
			"managed_agent.assistant_response",
			"managed_agent.execution_unanswered",
			"managed_agent.report_created",
		]);
		expect(events.find((event) => event.name === "managed_agent.execution_unanswered")?.attributes[
			"managed_agent.execution.reason"
		]).toBe("model_error");
		expect(events.find((event) => event.name === "managed_agent.tool_result")?.attributes["tool.output"])
			.toContain("tool output before model failure");
		expect(events.find((event) => event.name === "managed_agent.report_created")?.attributes["managed_agent.report.text"])
			.toContain("ended without an answer (model_error)");
	});

	it("correlates managed requests with child model/tool payloads and report creation", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { service, harness, faux, directory } = await setup([], 100_000, { entries: new Map(), valid: new Map() }, telemetry);
		const file = join(directory, "telemetry-tool-output.txt");
		await writeFile(file, "tool output visible in the managed trace", "utf8");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: file }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The delegated answer with useful details."),
		]);

		const spawned = await service.spawn("telemetry-worker", undefined, "Read the file and summarize it.");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);

		const spans = telemetry.getSpans();
		const requestSpan = spans.find((span) => span.name === "durable_subagents.request");
		const executionSpan = spans.find((span) => span.name === "durable_subagents.execution");
		expect(requestSpan?.attributes["managed_agent.task.text"]).toBe("Read the file and summarize it.");
		expect(executionSpan).toBeDefined();
		expect(executionSpan?.context["pi-memory-trace"]).toBe(requestSpan?.context["pi-memory-trace"]);
		expect(executionSpan?.events).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "managed_agent.user_message" }),
			expect.objectContaining({ name: "managed_agent.tool_call" }),
			expect.objectContaining({ name: "managed_agent.tool_result" }),
			expect.objectContaining({ name: "managed_agent.assistant_response" }),
			expect.objectContaining({ name: "managed_agent.report_created" }),
		]));
		const toolCall = executionSpan?.events.find((event) => event.name === "managed_agent.tool_call");
		const toolResult = executionSpan?.events.find((event) => event.name === "managed_agent.tool_result");
		expect(JSON.parse(String(toolCall?.attributes["tool.arguments"]))).toEqual({ path: file });
		expect(toolResult?.attributes["tool.output"]).toContain("tool output visible in the managed trace");
		const traces = spans.filter((span) => span.context["pi-memory-trace"] === requestSpan?.context["pi-memory-trace"]);
		expect(traces.some((span) => span.name === "pi.durable.phase")).toBe(true);
		const childSubmission = spans.find((span) => span.name === "pi.durable.submit");
		expect(childSubmission?.links.some((link) =>
			link.context["pi-memory-trace"] === executionSpan?.context["pi-memory-trace"],
		)).toBe(true);

		faux.setResponses([fauxAssistantMessage("The later request's answer.")]);
		const sent = await service.send("telemetry-worker", "Handle only this later request.");
		await harness.waitForTask(sent.reporterTaskId, BACKGROUND_CONTEXT);

		const sendExecution = telemetry.getSpans().find((span) =>
			span.name === "durable_subagents.execution"
			&& span.attributes["managed_agent.task.text"] === "Handle only this later request.",
		);
		const sendEvents = sendExecution?.events ?? [];
		expect(sendEvents.map((event) => event.name)).toEqual([
			"managed_agent.user_message",
			"managed_agent.assistant_response",
			"managed_agent.report_created",
		]);
		expect(JSON.stringify(sendEvents)).not.toContain("Read the file and summarize it.");
		expect(JSON.stringify(sendEvents)).not.toContain("telemetry-tool-output.txt");
		expect(JSON.stringify(sendEvents)).not.toContain("tool output visible in the managed trace");
	});

	it("assigns shared-run telemetry to each steered input segment once", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { service, harness, faux } = await setup([], 100_000, { entries: new Map(), valid: new Map() }, telemetry);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "sleep 1; printf 'shared-run-tool-output'" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The shared run answer."),
		]);

		const first = await service.spawn("steering-worker", undefined, "Start the first request.");
		const child = await harness.conversation(first.conversationId, BACKGROUND_CONTEXT);
		if (child === undefined) throw new Error("Expected the managed child conversation.");

		const deadline = Date.now() + 5_000;
		let toolCallVisible = false;
		while (Date.now() < deadline) {
			const view = await child.context(BACKGROUND_CONTEXT);
			toolCallVisible = view.entries.some((entry) =>
				AssistantEntry.is(entry)
				&& entry.model?.some((message) =>
					message.role === "assistant"
					&& message.content.some((part) => part.type === "toolCall" && part.name === "bash"),
				),
			);
			if (toolCallVisible) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(toolCallVisible).toBe(true);

		const second = await service.send("steering-worker", "Steer while the first request is running.");
		await Promise.all([
			harness.waitForTask(first.reporterTaskId, BACKGROUND_CONTEXT),
			harness.waitForTask(second.reporterTaskId, BACKGROUND_CONTEXT),
		]);

		const executions = telemetry.getSpans().filter((span) => span.name === "durable_subagents.execution");
		const firstExecution = executions.find((span) => span.attributes["managed_agent.task.text"] === "Start the first request.");
		const secondExecution = executions.find((span) => span.attributes["managed_agent.task.text"] === "Steer while the first request is running.");
		const firstEvents = firstExecution?.events ?? [];
		const secondEvents = secondExecution?.events ?? [];

		// Durable may settle both steered inputs with one answer. Transcript events before the later input
		// belong to the first trace; the later input and its resulting answer belong to the second trace.
		expect(faux.state.callCount).toBe(2);
		expect(firstEvents.map((event) => event.name)).toEqual([
			"managed_agent.user_message",
			"managed_agent.tool_call",
			"managed_agent.tool_result",
			"managed_agent.report_created",
		]);
		expect(secondEvents.map((event) => event.name)).toEqual([
			"managed_agent.user_message",
			"managed_agent.assistant_response",
			"managed_agent.report_created",
		]);
		expect(JSON.stringify(firstEvents)).not.toContain("Steer while the first request is running.");
		expect(JSON.stringify(secondEvents)).not.toContain("Start the first request.");
		expect(JSON.stringify(secondEvents)).not.toContain("shared-run-tool-output");
	});

	it("spawns, reuses, counts, reports, and retains a named child conversation", async () => {
		const { service, harness, root } = await setup(["first answer", "second answer"]);

		const spawned = await service.spawn("researcher", undefined, "Find one useful fact.");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);
		const first = await service.status("researcher");
		expect(first.active).toBe(false);
		expect(first.incomingCount).toBe(1);
		expect(first.outgoingCount).toBe(0);
		await expect(harness.snapshot(SubagentsDoc, root.id, BACKGROUND_CONTEXT))
			.resolves.toMatchObject({ agents: { researcher: { latestTask: "Find one useful fact.", fresh: true } } });
		const herdrTarget = { tabId: "w1:t2", paneId: "w1:p2" };
		await service.setHerdrTarget("researcher", herdrTarget);
		expect(await service.herdrTarget("researcher")).toEqual(herdrTarget);
		expect(await service.herdrOutputVersion("researcher")).toBeUndefined();
		await service.setHerdrOutputVersion("researcher", 1);
		expect(await service.herdrOutputVersion("researcher")).toBe(1);
		expect(await service.herdrAgents()).toEqual([{ name: "researcher", conversationId: spawned.conversationId }]);

		const sent = await service.send("researcher", "Add one more detail.");
		expect(sent.conversationId).toBe(spawned.conversationId);
		await harness.waitForTask(sent.reporterTaskId, BACKGROUND_CONTEXT);
		const reports = await service.pendingReports();
		expect(reports).toHaveLength(2);
		for (const report of reports) await service.markReportDelivered(report.id);
		for (const report of reports) await service.markReportDelivered(report.id);

		const reused = await service.status("researcher");
		expect(reused.conversationId).toBe(spawned.conversationId);
		expect(reused.incomingCount).toBe(2);
		expect(reused.outgoingCount).toBe(2);
		await expect(harness.snapshot(SubagentsDoc, root.id, BACKGROUND_CONTEXT))
			.resolves.toMatchObject({ agents: { researcher: { latestTask: "Add one more detail.", fresh: false } } });
		await service.stop("researcher");
		await expect(service.status("researcher")).resolves.toMatchObject({
			conversationId: spawned.conversationId,
			active: false,
		});
	});

	it("provides live footer data with cumulative assistant turns and executed tool uses", async () => {
		const { service, harness, faux, directory, model } = await setup([], 100);
		const file = join(directory, "footer-input.txt");
		await writeFile(file, "The footer test file.", "utf8");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: file }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The first request is complete."),
			fauxAssistantMessage("still working ".repeat(100)),
		]);

		const spawned = await service.spawn("footer-worker", undefined, "Read the footer test file.");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);
		const sent = await service.send("footer-worker", "Check one more detail.");
		const deadline = Date.now() + 5_000;
		let summary;
		while (Date.now() < deadline) {
			const summaries = await service.footerSummaries();
			summary = summaries.find(({ name }) => name === "footer-worker");
			if (faux.state.callCount >= 3 && summary?.turns === 2 && summary.toolUses === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(summary).toMatchObject({
			name: "footer-worker",
			active: true,
			modelLabel: model.id,
			thinkingLevel: "off",
			turns: 2,
			toolUses: 1,
			incomingCount: 2,
			latestTask: "Check one more detail.",
			fresh: false,
		});
		expect(summary?.contextTokens).toEqual(expect.any(Number));
		expect(summary?.contextWindow).toBeGreaterThan(0);
		await service.stop("footer-worker");
		await harness.waitForTask(sent.reporterTaskId, BACKGROUND_CONTEXT);
		await expect(service.footerSummaries()).resolves.toEqual([]);
		await expect(service.footerSummaries(true)).resolves.toMatchObject([
			{ name: "footer-worker", active: false, latestTask: "Check one more detail.", turns: 2, toolUses: 1 },
		]);
	}, 10_000);

	it("makes requested names unique against idle registered agents", async () => {
		const { service, harness } = await setup(["one", "two"]);
		const first = await service.spawn("worker", undefined, "First task.");
		await harness.waitForTask(first.reporterTaskId, BACKGROUND_CONTEXT);
		const second = await service.spawn("worker", undefined, "Second task.");
		await harness.waitForTask(second.reporterTaskId, BACKGROUND_CONTEXT);

		expect(second.name).toBe("worker-2");
		expect((await service.list()).map((agent) => agent.name)).toEqual(["worker", "worker-2"]);
	});

	it("defaults missing persisted message counters to zero", async () => {
		const { service, harness, root } = await setup(["legacy answer"]);
		const spawned = await service.spawn("legacy-agent", undefined, "Create existing state.");
		await harness.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);
		await root.commit(async (tx) => {
			const state = await tx.doc(SubagentsDoc, root.id);
			const record = state.agents["legacy-agent"] as unknown as { incomingCount?: number; outgoingCount?: number };
			delete record.incomingCount;
			delete record.outgoingCount;
		}, BACKGROUND_CONTEXT);

		expect(await service.status("legacy-agent")).toMatchObject({ incomingCount: 0, outgoingCount: 0 });
	});

	it("rejects an unavailable explicit model before creating any managed agent", async () => {
		const preset: AgentPreset = {
			id: "unavailable",
			description: "An unavailable model.",
			instructions: "Invalid model must fail before creation.",
			model: { provider: "faux", modelId: "not-installed" },
		};
		const presets: PresetCatalog = {
			entries: new Map([[preset.id, { preset }]]),
			valid: new Map([[preset.id, preset]]),
		};
		const { service } = await setup([], 100_000, presets);

		await expect(service.spawn("unavailable", undefined, "Try this preset.")).rejects.toThrow(/not present in Pi's model registry/);
		await expect(service.list()).resolves.toEqual([]);
	});

	it("rejects an explicit model without configured provider authentication", async () => {
		const preset: AgentPreset = {
			id: "no-login",
			description: "A model that needs authentication.",
			instructions: "Never fall back to another provider.",
			model: { provider: "faux", modelId: "faux-pinned" },
		};
		const presets: PresetCatalog = {
			entries: new Map([[preset.id, { preset }]]),
			valid: new Map([[preset.id, preset]]),
		};
		const { service, modelRegistry } = await setup([], 100_000, presets);
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);

		await expect(service.spawn("no-login", undefined, "Try this preset.")).rejects.toThrow(/unavailable with Pi's configured provider authentication/);
		await expect(service.list()).resolves.toEqual([]);
	});

	it("enables Code Mode while restricting its callable tools to a preset allowlist", async () => {
		const sandbox = new CodemodeSandbox();
		codemodeSandboxes.push(sandbox);
		const codemodeExtension = createCodemodeExtension({ sandbox, models: false });
		const preset: AgentPreset = {
			id: "scout",
			description: "Explore read-only.",
			instructions: "Do not edit files.",
			tools: ["read", "bash"],
			thinking: "low",
			codemode: true,
		};
		const presets: PresetCatalog = {
			entries: new Map([[preset.id, { preset }]]),
			valid: new Map([[preset.id, preset]]),
		};
		const { service, harness } = await setup([], 100_000, presets, undefined, codemodeExtension);
		const spawned = await service.spawn("scout", undefined, "Inspect the project.");
		const child = await harness.conversation(spawned.conversationId, BACKGROUND_CONTEXT);
		const agent = await child?.agent(BACKGROUND_CONTEXT);

		expect(codemodeExtension.tools?.map((tool) => tool.name)).toEqual(["codemode"]);
		expect(agent?.extensions.map((extension) => extension.name)).toEqual(["coding-tools", "codemode"]);
		expect(agent?.tools.map((tool) => tool.name)).toEqual(["read", "bash", "codemode"]);
		expect(agent?.callable.map((tool) => tool.name)).toEqual(["read", "bash"]);
		expect(agent?.thinkingLevel).toBe("low");
	});

	it("stats total only managed child usage and sort agents by descending cost", async () => {
		const { service, harness, root } = await setup(["first", "second"]);
		const first = await service.spawn("first-agent", undefined, "First task.");
		const second = await service.spawn("second-agent", undefined, "Second task.");
		await Promise.all([
			harness.waitForTask(first.reporterTaskId, BACKGROUND_CONTEXT),
			harness.waitForTask(second.reporterTaskId, BACKGROUND_CONTEXT),
		]);

		const usage = (input: number, cost: number) => ({
			input,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: input + 9,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		});
		for (const [conversationId, input, cost] of [
			[first.conversationId, 10, 0.1],
			[second.conversationId, 20, 0.4],
		] as const) {
			const child = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
			await child!.commit(async (tx) => {
				const state = await tx.doc(UsageDoc, conversationId);
				state.models["faux/faux-parent"] = usage(input, cost) as never;
			}, BACKGROUND_CONTEXT);
		}
		await root.commit(async (tx) => {
			const state = await tx.doc(UsageDoc, root.id);
			state.models["faux/faux-parent"] = usage(999, 99) as never;
		}, BACKGROUND_CONTEXT);

		const stats = await service.stats();
		expect(stats.total).toMatchObject({ input: 30, output: 4, totalTokens: 48, cost: 0.5 });
		expect(stats.rows.map(({ name }) => name)).toEqual(["second-agent", "first-agent"]);
	});

	it("stop-all cancels active managed work but retains idle registered agents", async () => {
		const { service } = await setup(["ignored one", "ignored two"]);
		await service.spawn("first-worker", undefined, "Work that will be stopped.");
		await service.spawn("second-worker", undefined, "More work that will be stopped.");

		const stopped = await service.stopAll();
		expect(stopped.sort()).toEqual(["first-worker", "second-worker"]);
		expect((await service.list()).map(({ name, active }) => ({ name, active }))).toEqual([
			{ name: "first-worker", active: false },
			{ name: "second-worker", active: false },
		]);
		expect(await service.pendingReports()).toEqual([]);
		expect((await service.herdrDisplayAgents()).every(({ active }) => !active)).toBe(true);
		expect((await service.status("first-worker")).outgoingCount).toBe(0);
	});

	it("tracks model and thinking inheritance while preserving explicit preset allowlists", async () => {
		const catalog: PresetCatalog = {
			valid: new Map(),
			entries: new Map(),
		};
		const preset: AgentPreset = {
			id: "pinned",
			description: "A pinned agent configuration.",
			instructions: "Use the pinned configuration.",
			model: { provider: "faux", modelId: "faux-pinned" },
				thinking: "low",
				tools: ["read"],
			};
		(catalog.entries as Map<string, { preset: AgentPreset }>).set("pinned", { preset });
		(catalog.valid as Map<string, AgentPreset>).set("pinned", preset);
		const { service, harness, model } = await setup(["inherited", "pinned", "generic"], 100_000, catalog);

		const inherited = await service.spawn("default", undefined, "Use the current parent settings.");
		const pinned = await service.spawn("pinned", undefined, "Use the configured preset.");
		const generic = await service.spawn("ad-hoc", "missing-preset", "Use the generic tool set.");
		await Promise.all([
			harness.waitForTask(inherited.reporterTaskId, BACKGROUND_CONTEXT),
			harness.waitForTask(pinned.reporterTaskId, BACKGROUND_CONTEXT),
			harness.waitForTask(generic.reporterTaskId, BACKGROUND_CONTEXT),
		]);

		const newParent = { provider: model.provider, modelId: "faux-pinned" };
		await service.updateInherited(newParent, "high");
		const inheritedConfig = await harness.snapshot(AgentDoc, inherited.conversationId, BACKGROUND_CONTEXT);
		const pinnedConfig = await harness.snapshot(AgentDoc, pinned.conversationId, BACKGROUND_CONTEXT);
		const genericConfig = await harness.snapshot(AgentDoc, generic.conversationId, BACKGROUND_CONTEXT);

		expect(inheritedConfig).toMatchObject({ model: newParent, thinkingLevel: "high" });
		expect(pinnedConfig).toMatchObject({ model: { provider: "faux", modelId: "faux-pinned" }, thinkingLevel: "low", tools: ["read"], modelTools: ["read"] });
		expect(genericConfig).toMatchObject({ model: newParent, thinkingLevel: "high" });
		expect(genericConfig?.tools).toBeUndefined();
		expect(genericConfig?.modelTools).toBeUndefined();
		expect((await service.status("ad-hoc")).presetId).toBeNull();
	});

	it("reopens a child run and pending reporter from the same SQLite sidecar", async () => {
		const slowAnswer = "x".repeat(250);
		const setupResult = await setup([slowAnswer], 1);
		const { service, harness, faux, models, durableRegistry, cwd, directory, modelRegistry, parentModel } = setupResult;
		const spawned = await service.spawn("resumable", undefined, "Keep working across restart.");

		const deadline = Date.now() + 3_000;
		while (!(await service.status("resumable")).active && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect((await service.status("resumable")).active).toBe(true);
		await service.setHerdrPaneCreationPending(true);
		const displayBeforeRestart = (await service.herdrDisplayAgents())[0]!;
		expect(displayBeforeRestart.workStart).toEqual(expect.any(Number));

		const openIndex = openHarnesses.indexOf(harness);
		if (openIndex >= 0) openHarnesses.splice(openIndex, 1);
		await harness.close(BACKGROUND_CONTEXT);
		faux.appendResponses([fauxAssistantMessage("Recovered after restart.")]);

		const reopened = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
			models,
			registry: durableRegistry,
			settings: { extensions: [CodingTools] },
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
		}, BACKGROUND_CONTEXT);
		openHarnesses.push(reopened);
		const root = await reopened.root(BACKGROUND_CONTEXT, {
			agent: { model: parentModel, thinkingLevel: "off", extensions: [CodingTools] },
		});
		const reopenedService = new AgentService({
			harness: reopened,
			root,
			cwd,
			presets: { entries: new Map(), valid: new Map() },
			modelRegistry,
			parentModel,
			parentThinking: "off",
		});
		expect(await reopenedService.herdrPaneCreationPending()).toBe(true);
		reopened.resume();
		await reopened.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);

		expect(await reopenedService.status("resumable")).toMatchObject({
			conversationId: spawned.conversationId,
			incomingCount: 1,
		});
		expect((await reopenedService.herdrDisplayAgents())[0]).toEqual({ ...displayBeforeRestart, active: false });
		expect(await reopenedService.herdrPaneCreationPending()).toBe(true);
		await reopenedService.setHerdrPaneCreationPending(false);
		expect(await reopenedService.herdrPaneCreationPending()).toBe(false);
		const recoveredReports = await reopenedService.pendingReports();
		expect(recoveredReports).toEqual([
			expect.objectContaining({ agentName: "resumable", text: expect.any(String), delivered: false }),
		]);
	}, 20_000);
});
