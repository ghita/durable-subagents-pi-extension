import { describe, expect, it, vi } from "vitest";
import { HerdrAgentMonitor, HerdrCliApi, herdrApiFromEnvironment, herdrMetadataForAgent, herdrProgressText } from "../src/herdr-monitor.ts";
import type { HerdrApi, HerdrMetadata } from "../src/herdr-monitor.ts";
import type { ConversationView, ConversationWatch } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HerdrTarget } from "../src/agent-service.ts";

function view(docs: Record<string, unknown> = {}, entries: unknown[] = []): ConversationView {
	return { conversation: {} as never, entries, docs } as unknown as ConversationView;
}

describe("Herdr CLI API adapter", () => {
	it("splits the current tab and reports pane metadata through the supported CLI API", async () => {
		const calls: string[][] = [];
		const run = vi.fn(async (args: readonly string[]) => {
			calls.push([...args]);
			if (args[0] === "pane" && args[1] === "split") {
				return JSON.stringify({
					id: "cli:pane:split",
					result: { type: "pane_split", pane: { pane_id: "w1:p2", tab_id: "w1:t1" } },
				});
			}
			if (args[0] === "pane" && args[1] === "get") {
				return JSON.stringify({ id: "cli:pane:get", result: { type: "pane_info", pane: { pane_id: "w1:p2", tab_id: "w1:t1" } } });
			}
			if (args[0] === "pane" && args[1] === "layout") {
				return JSON.stringify({ id: "cli:pane:layout", result: { layout: { panes: [{ pane_id: "w1:p2", rect: { x: 10, y: 20, width: 30, height: 40 } }] } } });
			}
			return JSON.stringify({ id: "cli:ok", result: { type: "ok" } });
		});
		const api = new HerdrCliApi(run, "w1:t1");

		await expect(api.createPane("C:/project", "researcher", "w1:p1")).resolves.toEqual({ tabId: "w1:t1", paneId: "w1:p2" });
		await api.getPane("w1:p2");
		await api.reportMetadata("w1:p2", {
			displayAgent: "researcher",
			title: "researcher · high · read (running)",
			tokens: { thinking: "high", activity: "working", tools: "read (running)" },
		});
		const progress = "Durable agent: researcher\nStatus: working\nThinking: high\nTools: read (running)\nRecent inputs:\n1. Find the weather report.\nLatest response: Looking into it.";
		await api.writeProgress("w1:p2", progress);
		await api.createPane("C:/project", "writer", "w1:p3", "down");
		await expect(api.paneLayout("w1:p1")).resolves.toEqual([{ paneId: "w1:p2", rect: { x: 10, y: 20, width: 30, height: 40 } }]);
		await api.resizePane("w1:p2", "up", 0.125);

		expect(calls[0]).toEqual(["pane", "split", "w1:p1", "--direction", "right", "--no-focus", "--cwd", "C:/project"]);
		expect(calls[1]).toEqual(["pane", "rename", "w1:p2", "researcher"]);
		expect(calls[2]).toEqual(["pane", "get", "w1:p2"]);
		expect(calls[3]).toContain("--source");
		expect(calls[3]).toContain("pi-durable-subagents");
		expect(calls[3]).toContain("--token");
		expect(calls[3]).toContain("tools=read (running)");
		expect(calls[4]?.slice(0, 3)).toEqual(["pane", "run", "w1:p2"]);
		expect(calls[4]?.[3]).toContain(Buffer.from(progress, "utf8").toString("base64"));
		expect(calls[4]?.[3]).toContain("\\x1b[3J\\x1b[2J\\x1b[H");
		expect(calls[5]).toEqual(["pane", "split", "w1:p3", "--direction", "down", "--no-focus", "--cwd", "C:/project"]);
		expect(calls[7]).toEqual(["pane", "layout", "--pane", "w1:p1"]);
		expect(calls[8]).toEqual(["pane", "resize", "--direction", "up", "--amount", "0.125", "--pane", "w1:p2"]);
	});

	it("is enabled only in a Herdr-managed pane with a workspace ID", () => {
		expect(herdrApiFromEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" })).toBeDefined();
		expect(herdrApiFromEnvironment({ HERDR_ENV: "1" })).toBeUndefined();
		expect(herdrApiFromEnvironment({ HERDR_WORKSPACE_ID: "w1" })).toBeUndefined();
	});
});

describe("Herdr live agent activity", () => {
	it("shows thinking level and live tool statuses without exposing tool arguments", () => {
		const metadata = herdrMetadataForAgent("researcher", "medium", view({
			"pi.agent": { thinkingLevel: "high" },
			"pi.live": {
				run: { taskId: "run-1", inputs: [], turns: 1 },
				tools: [{ callId: "call-1", name: "read", status: "running", arguments: { path: "secret.txt" } }],
			},
		}));

		expect(metadata).toEqual<HerdrMetadata>({
			displayAgent: "researcher",
			title: "researcher · high · read (running)",
			tokens: { thinking: "high", activity: "working", tools: "read (running)" },
		});
		expect(JSON.stringify(metadata)).not.toContain("secret.txt");
		expect(herdrProgressText("researcher", "medium", view({
			"pi.agent": { thinkingLevel: "high" },
			"pi.live": {
				run: { taskId: "run-1", inputs: [], turns: 1 },
				tools: [{ callId: "call-1", name: "read", status: "running", arguments: { path: "secret.txt" } }],
			},
		}, [
			{ kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Find the weather report." }] }] },
			{ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Looking into it." }] }] },
		]))).toBe("Durable agent: researcher\nStatus: working\nThinking: high\nTools: read (running)\nRecent inputs:\n1. Find the weather report.\nLatest response: Looking into it.");
		expect(herdrProgressText("researcher", "medium", view({ "pi.live": { tools: [{ name: "read", status: "running", arguments: { path: "secret.txt" } }] } }))).not.toContain("secret.txt");
	});

	it("opens one sibling pane, persists its identity, and streams subsequent conversation updates", async () => {
		const initialView = view({
			"pi.agent": { thinkingLevel: "high" },
			"pi.live": {
				run: { taskId: "run-1", inputs: [], turns: 1 },
				tools: [{ callId: "call-1", name: "read", status: "running" }],
			},
		});
		let listener: ((call: any, context: any) => Promise<void>) | undefined;
		const watch = {
			value: initialView,
			start: (callback: typeof listener) => { listener = callback; },
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch;
		const conversation = {
			agent: vi.fn(async () => ({ thinkingLevel: "high" })),
			watch: vi.fn(async () => watch),
		};
		const target: HerdrTarget = { tabId: "w1:t3", paneId: "w1:p3" };
		const service = {
			herdrTarget: vi.fn(async () => undefined),
			setHerdrTarget: vi.fn(async () => undefined),
			herdrAgents: vi.fn(async () => []),
		};
		const api: HerdrApi = {
			createPane: vi.fn(async () => target),
			getPane: vi.fn(async () => target),
			movePane: vi.fn(async () => target),
			paneLayout: vi.fn(async () => []),
			resizePane: vi.fn(async () => undefined),
			reportMetadata: vi.fn(async () => undefined),
			writeProgress: vi.fn(async () => undefined),
		};
		const monitor = new HerdrAgentMonitor({
			api,
			cwd: "C:/project",
			harness: { conversation: vi.fn(async () => conversation) } as never,
			service: service as never,
		});

		await monitor.trackAgent("researcher", "conversation-1" as never);
		expect(api.createPane).toHaveBeenCalledWith("C:/project", "researcher", undefined, "right");
		expect(service.setHerdrTarget).toHaveBeenCalledWith("researcher", target);
		expect(api.reportMetadata).toHaveBeenCalledTimes(1);
		expect(api.reportMetadata).toHaveBeenLastCalledWith("w1:p3", expect.objectContaining({
			tokens: { thinking: "high", activity: "working", tools: "read (running)" },
		}));
		expect(api.writeProgress).toHaveBeenLastCalledWith("w1:p3", "Durable agent: researcher\nStatus: working\nThinking: high\nTools: read (running)\nRecent inputs:\n(none)\nLatest response: Waiting for response");

		const nextView = view({
			"pi.agent": { thinkingLevel: "low" },
			"pi.live": { tools: [{ callId: "call-2", name: "bash", status: "done" }] },
		});
		await listener?.({ kind: "value", value: nextView, ops: [], retired: false }, BACKGROUND_CONTEXT);
		expect(api.reportMetadata).toHaveBeenCalledTimes(2);
		expect(api.reportMetadata).toHaveBeenLastCalledWith("w1:p3", expect.objectContaining({
			title: "researcher · low · bash (done)",
			tokens: { thinking: "low", activity: "idle", tools: "bash (done)" },
		}));
		expect(api.writeProgress).toHaveBeenLastCalledWith("w1:p3", "Durable agent: researcher\nStatus: idle\nThinking: low\nTools: bash (done)\nRecent inputs:\n(none)\nLatest response: Waiting for response");

		await monitor.close();
		expect(watch.stop).toHaveBeenCalledOnce();
	});

	it("anchors each additional agent pane to the previous rightmost pane", async () => {
		const root: HerdrTarget = { tabId: "w1:t1", paneId: "w1:p1" };
		const first: HerdrTarget = { tabId: "w1:t1", paneId: "w1:p2" };
		const second: HerdrTarget = { tabId: "w1:t1", paneId: "w1:p3" };
		const watches = [first, second].map(() => ({
			value: view({ "pi.agent": { thinkingLevel: "medium" } }),
			start: vi.fn(),
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch));
		let conversationIndex = 0;
		const service = {
			herdrTarget: vi.fn(async () => undefined),
			setHerdrTarget: vi.fn(async () => undefined),
			herdrAgents: vi.fn(async () => []),
		};
		const api: HerdrApi = {
			createPane: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			getPane: vi.fn(),
			movePane: vi.fn(),
			paneLayout: vi.fn(async () => []),
			resizePane: vi.fn(async () => undefined),
			reportMetadata: vi.fn(async () => undefined),
			writeProgress: vi.fn(async () => undefined),
		};
		const monitor = new HerdrAgentMonitor({
			api,
			currentPane: root,
			cwd: "C:/project",
			harness: { conversation: async () => ({
				agent: async () => ({ thinkingLevel: "medium" }),
				watch: async () => watches[conversationIndex++],
			}) } as never,
			service: service as never,
		});

		await monitor.trackAgent("first", "conversation-first" as never);
		await monitor.trackAgent("second", "conversation-second" as never);

		expect(api.createPane).toHaveBeenNthCalledWith(1, "C:/project", "first", root.paneId, "right");
		expect(api.createPane).toHaveBeenNthCalledWith(2, "C:/project", "second", first.paneId, "down");
		await monitor.close();
	});

	it("resizes the right-side agent stack to equal row heights", async () => {
		const root: HerdrTarget = { tabId: "w1:t1", paneId: "w1:p1" };
		const targets: HerdrTarget[] = [
			{ tabId: "w1:t1", paneId: "w1:p2" },
			{ tabId: "w1:t1", paneId: "w1:p3" },
			{ tabId: "w1:t1", paneId: "w1:p4" },
		];
		const watches = targets.map(() => ({
			value: view({ "pi.agent": { thinkingLevel: "medium" } }),
			start: vi.fn(),
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch));
		const twoEqualRows = targets.slice(0, 2).map((target, index) => ({
			paneId: target.paneId,
			rect: { x: 100, y: index * 30, width: 100, height: 30 },
		}));
		const threeUnequalRows = [30, 15, 15].map((height, index) => ({
			paneId: targets[index]!.paneId,
			rect: { x: 100, y: index === 0 ? 0 : index === 1 ? 30 : 45, width: 100, height },
		}));
		const threeEqualRows = targets.map((target, index) => ({
			paneId: target.paneId,
			rect: { x: 100, y: index * 20, width: 100, height: 20 },
		}));
		let layoutCalls = 0;
		let conversationIndex = 0;
		const service = {
			herdrTarget: vi.fn(async () => undefined),
			setHerdrTarget: vi.fn(async () => undefined),
			herdrAgents: vi.fn(async () => []),
		};
		const api: HerdrApi = {
			createPane: vi.fn().mockResolvedValueOnce(targets[0]).mockResolvedValueOnce(targets[1]).mockResolvedValueOnce(targets[2]),
			getPane: vi.fn(),
			movePane: vi.fn(),
			paneLayout: vi.fn(async () => {
				layoutCalls++;
				return layoutCalls === 1 ? twoEqualRows : layoutCalls === 2 ? threeUnequalRows : threeEqualRows;
			}),
			resizePane: vi.fn(async () => undefined),
			reportMetadata: vi.fn(async () => undefined),
			writeProgress: vi.fn(async () => undefined),
		};
		const monitor = new HerdrAgentMonitor({
			api,
			currentPane: root,
			cwd: "C:/project",
			harness: { conversation: async () => ({
				agent: async () => ({ thinkingLevel: "medium" }),
				watch: async () => watches[conversationIndex++],
			}) } as never,
			service: service as never,
		});

		await monitor.trackAgent("first", "conversation-first" as never);
		await monitor.trackAgent("second", "conversation-second" as never);
		await monitor.trackAgent("third", "conversation-third" as never);

		expect(api.resizePane).toHaveBeenCalledOnce();
		expect(api.resizePane).toHaveBeenCalledWith(targets[0]!.paneId, "up", expect.closeTo(1 / 6, 5));
		await monitor.close();
	});

	it("recreates a pane that was closed while the monitor is active", async () => {
		const original: HerdrTarget = { tabId: "w1:t3", paneId: "w1:p3" };
		const reopened: HerdrTarget = { tabId: "w1:t3", paneId: "w1:p4" };
		const watch = {
			value: view({ "pi.agent": { thinkingLevel: "medium" } }),
			start: vi.fn(),
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch;
		const service = {
			herdrTarget: vi.fn(async () => undefined),
			setHerdrTarget: vi.fn(async () => undefined),
			herdrAgents: vi.fn(async () => []),
		};
		const api: HerdrApi = {
			createPane: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(reopened),
			getPane: vi.fn(async () => { throw new Error("Pane was closed."); }),
			movePane: vi.fn(),
			paneLayout: vi.fn(async () => []),
			resizePane: vi.fn(async () => undefined),
			reportMetadata: vi.fn(async () => undefined),
			writeProgress: vi.fn(async () => undefined),
		};
		const conversation = { agent: async () => ({ thinkingLevel: "medium" }), watch: async () => watch };
		const monitor = new HerdrAgentMonitor({
			api,
			cwd: "C:/project",
			harness: { conversation: async () => conversation } as never,
			service: service as never,
		});

		await monitor.trackAgent("writer", "conversation-closed-pane" as never);
		await monitor.trackAgent("writer", "conversation-closed-pane" as never);

		expect(api.createPane).toHaveBeenCalledTimes(2);
		expect(service.setHerdrTarget).toHaveBeenLastCalledWith("writer", reopened);
		expect(api.reportMetadata).toHaveBeenLastCalledWith("w1:p4", expect.any(Object));
		expect(api.writeProgress).toHaveBeenLastCalledWith("w1:p4", expect.stringContaining("Durable agent: writer"));
		await monitor.close();
	});

	it("repositions a persisted pane below the main pane in the current tab", async () => {
		const stored: HerdrTarget = { tabId: "w1:t1", paneId: "w1:p4" };
		const watch = {
			value: view({ "pi.agent": { thinkingLevel: "medium" } }),
			start: vi.fn(),
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch;
		const service = {
			herdrTarget: vi.fn(async () => stored),
			setHerdrTarget: vi.fn(),
			herdrAgents: vi.fn(),
		};
		const api: HerdrApi = {
			createPane: vi.fn(),
			getPane: vi.fn(async () => stored),
			movePane: vi.fn(async () => stored),
			paneLayout: vi.fn(async () => []),
			resizePane: vi.fn(async () => undefined),
			reportMetadata: vi.fn(async () => undefined),
			writeProgress: vi.fn(async () => undefined),
		};
		const conversation = { agent: async () => ({ thinkingLevel: "medium" }), watch: async () => watch };
		const monitor = new HerdrAgentMonitor({
			api,
			currentPane: { tabId: "w1:t1", paneId: "w1:p1" },
			cwd: "C:/project",
			harness: { conversation: async () => conversation } as never,
			service: service as never,
		});

		await monitor.trackAgent("writer", "conversation-2" as never);
		expect(api.getPane).toHaveBeenCalledWith(stored.paneId);
		expect(api.movePane).toHaveBeenCalledWith(stored.paneId, "w1:t1", "w1:p1", "writer", "right");
		expect(api.createPane).not.toHaveBeenCalled();
		expect(service.setHerdrTarget).toHaveBeenCalledWith("writer", stored);
		await monitor.close();
	});

	it("moves a persisted pane from an older tab into the current tab", async () => {
		const stored: HerdrTarget = { tabId: "w1:t4", paneId: "w1:p4" };
		const moved: HerdrTarget = { tabId: "w1:t1", paneId: "w1:p4" };
		const watch = {
			value: view({ "pi.agent": { thinkingLevel: "medium" } }),
			start: vi.fn(),
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch;
		const service = {
			herdrTarget: vi.fn(async () => stored),
			setHerdrTarget: vi.fn(async () => undefined),
			herdrAgents: vi.fn(async () => []),
		};
		const api: HerdrApi = {
			createPane: vi.fn(),
			getPane: vi.fn(async () => stored),
			movePane: vi.fn(async () => moved),
			paneLayout: vi.fn(async () => []),
			resizePane: vi.fn(async () => undefined),
			reportMetadata: vi.fn(async () => undefined),
			writeProgress: vi.fn(async () => undefined),
		};
		const conversation = { agent: async () => ({ thinkingLevel: "medium" }), watch: async () => watch };
		const monitor = new HerdrAgentMonitor({
			api,
			currentPane: { tabId: "w1:t1", paneId: "w1:p1" },
			cwd: "C:/project",
			harness: { conversation: async () => conversation } as never,
			service: service as never,
		});

		await monitor.trackAgent("writer", "conversation-3" as never);
		expect(api.movePane).toHaveBeenCalledWith(stored.paneId, "w1:t1", "w1:p1", "writer", "right");
		expect(service.setHerdrTarget).toHaveBeenCalledWith("writer", moved);
		expect(api.createPane).not.toHaveBeenCalled();
		await monitor.close();
	});
});
