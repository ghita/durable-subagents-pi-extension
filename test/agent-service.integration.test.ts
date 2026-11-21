import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AgentDoc,
	createRegistry,
	Harness,
	type ModelRef,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.ts";
import type { AgentPreset, PresetCatalog } from "../src/presets.ts";
import { SubagentsDoc } from "../src/agent-state.ts";
import { SubagentTasksExtension } from "../src/tasks.ts";

const directories: string[] = [];
const openHarnesses: Harness[] = [];

afterEach(async () => {
	await Promise.all(openHarnesses.splice(0).map((harness) => harness.close(BACKGROUND_CONTEXT)));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(
	responses: string[],
	tokensPerSecond = 100_000,
	presets: PresetCatalog = { entries: new Map(), valid: new Map() },
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
	durableRegistry.install(SubagentTasksExtension);
	const cwd = process.cwd();
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
		models,
		registry: durableRegistry,
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
	});
	harness.resume();
	return { service, harness, root, modelRegistry, model, directory, faux, models, durableRegistry, cwd, parentModel, presets };
}

describe("AgentService durable lifecycle", () => {
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

	it("rejects an explicit model that lacks the inherited Pi login", async () => {
		const preset: AgentPreset = {
			id: "no-login",
			instructions: "Never fall back to another provider.",
			model: { provider: "faux", modelId: "faux-pinned" },
		};
		const presets: PresetCatalog = {
			entries: new Map([[preset.id, { preset }]]),
			valid: new Map([[preset.id, preset]]),
		};
		const { service, modelRegistry } = await setup([], 100_000, presets);
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);

		await expect(service.spawn("no-login", undefined, "Try this preset.")).rejects.toThrow(/unavailable with the inherited Pi login/);
		await expect(service.list()).resolves.toEqual([]);
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
		expect((await service.status("first-worker")).outgoingCount).toBe(0);
	});

	it("tracks model and thinking inheritance while preserving explicit preset allowlists", async () => {
		const catalog: PresetCatalog = {
			valid: new Map(),
			entries: new Map(),
		};
		const preset: AgentPreset = {
			id: "pinned",
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
		reopened.resume();
		await reopened.waitForTask(spawned.reporterTaskId, BACKGROUND_CONTEXT);

		expect(await reopenedService.status("resumable")).toMatchObject({
			conversationId: spawned.conversationId,
			incomingCount: 1,
		});
		const recoveredReports = await reopenedService.pendingReports();
		expect(recoveredReports).toEqual([
			expect.objectContaining({ agentName: "resumable", text: expect.any(String), delivered: false }),
		]);
	}, 20_000);
});
