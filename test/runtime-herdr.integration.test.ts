import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.ts";
import { SubagentsDoc } from "../src/agent-state.ts";
import { HerdrAgentMonitor, type HerdrApi } from "../src/herdr-monitor.ts";
import { SubagentTasksExtension } from "../src/tasks.ts";

it("real Durable work yields its display while its completed report is still pending; unchanged refreshes do not write the root", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-herdr-integration-"));
	const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 }, models: [{ id: "parent" }] });
	faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Still working. ".repeat(1_000))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(SubagentTasksExtension);
	const cwd = process.cwd();
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
		models, registry, settings: { extensions: [CodingTools] },
		env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
	}, BACKGROUND_CONTEXT);
	let monitor: HerdrAgentMonitor | undefined;
	let detach: (() => void) | undefined;
	try {
		const model = faux.getModel();
		const parentModel = { provider: model.provider, modelId: model.id };
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: parentModel, thinkingLevel: "off", extensions: [CodingTools] },
		});
		await root.commit(async (tx) => { await tx.doc(SubagentsDoc, root.id); }, BACKGROUND_CONTEXT);
		const service = new AgentService({ harness, root, cwd, presets: { entries: new Map(), valid: new Map() },
			modelRegistry: { find: () => model, hasConfiguredAuth: () => true } as unknown as ModelRegistry,
			parentModel, parentThinking: "off",
		});
		const target = { tabId: "w1:t1", paneId: "w1:p2" };
		const api: HerdrApi = {
			createPane: vi.fn(async () => target), getPane: vi.fn(async () => target),
			movePane: vi.fn(async () => target), paneLayout: vi.fn(async () => []),
			resizePane: vi.fn(async () => undefined), reportMetadata: vi.fn(async () => undefined),
			appendText: vi.fn(async () => undefined), resetText: vi.fn(async () => undefined),
			closePane: vi.fn(async () => undefined),
		};
		const onError = vi.fn();
		monitor = new HerdrAgentMonitor({ api, service, harness, cwd, paneLimit: 1, onError,
			currentPane: { tabId: "w1:t1", paneId: "w1:p1" },
		});
		// Hold execution until the first active agent is allocated a pane.
		const first = await service.spawn("first", undefined, "Finish this short task.");
		await monitor.trackAgent(first.name, first.conversationId);
		expect(api.createPane).toHaveBeenCalledOnce();
		harness.resume();
		await harness.waitForTask(first.reporterTaskId, BACKGROUND_CONTEXT);
		expect((await service.pendingReports()).map((report) => report.agentName)).toContain("first");
		const second = await service.spawn("second", undefined, "Keep working on the next task.");
		await monitor.trackAgent(second.name, second.conversationId);
		expect(api.createPane).toHaveBeenCalledOnce();
		expect(api.resetText).toHaveBeenCalledWith(target.paneId);
		expect(api.reportMetadata).toHaveBeenLastCalledWith(target.paneId, expect.objectContaining({ displayAgent: "second" }));
		expect((await service.pendingReports()).map((report) => report.agentName)).toContain("first");
		await monitor.refresh();
		const advance = vi.fn();
		const observation = await harness.observeDoc(SubagentsDoc, root.id, { advance, end: () => undefined }, BACKGROUND_CONTEXT);
		detach = () => observation?.detach();
		for (let index = 0; index < 5; index++) await monitor.refresh();
		expect(advance).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		await monitor.setPaneLimit(0);
	} finally {
		detach?.();
		await monitor?.close();
		await harness.close(BACKGROUND_CONTEXT);
		await rm(directory, { recursive: true, force: true });
	}
}, 10_000);
