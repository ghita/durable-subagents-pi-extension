import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { HerdrAgentMonitor, HerdrCliApi, herdrApiFromEnvironment, herdrHeaderText, herdrMetadataForAgent } from "../src/herdr-monitor.ts";
import type { HerdrApi, HerdrMetadata } from "../src/herdr-monitor.ts";
import type { ConversationView, ConversationWatch } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HerdrTarget } from "../src/agent-service.ts";

function view(docs: Record<string, unknown> = {}, entries: unknown[] = []): ConversationView {
	return { conversation: {} as never, entries, docs } as unknown as ConversationView;
}

function entry(kind: string, id: number, message: unknown): unknown {
	return { kind, id, model: [message] };
}

async function startFakeRenderer(socketPath: string, appended: string[]): Promise<Server> {
	const server = createServer((socket) => {
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const request = JSON.parse(buffered.slice(0, newline)) as { type: string; id: string; text?: string };
			if (request.type === "append" && request.text !== undefined) appended.push(request.text);
			socket.end(`${JSON.stringify({ id: request.id, ok: true })}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return server;
}

async function closeServer(server: Server | undefined): Promise<void> {
	if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
	if (child === undefined || child.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill();
	await exited;
}

describe("Herdr CLI API adapter", () => {
	it("splits the current tab and reports pane metadata through the supported CLI API", async () => {
		const calls: string[][] = [];
		const appended: string[] = [];
		let renderer: Server | undefined;
		const run = vi.fn(async (args: readonly string[]) => {
			calls.push([...args]);
			if (args[0] === "pane" && args[1] === "run") {
				const encodedValues = [...(args[3] ?? "").matchAll(/Buffer\.from\('([^']+)','base64'\)/g)].map((match) => match[1]!);
				const socketPath = encodedValues[1] === undefined ? undefined : Buffer.from(encodedValues[1], "base64").toString("utf8");
				if (socketPath !== undefined) renderer = await startFakeRenderer(socketPath, appended);
			}
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
			title: "researcher · test-provider/test-model · thinking high",
			tokens: { model: "test-provider/test-model", thinking: "high" },
		});
		const progress = "[assistant]\nI will inspect the project.";
		await api.appendText("w1:p2", progress);
		await api.createPane("C:/project", "writer", "w1:p3", "down");
		await expect(api.paneLayout("w1:p1")).resolves.toEqual([{ paneId: "w1:p2", rect: { x: 10, y: 20, width: 30, height: 40 } }]);
		await api.resizePane("w1:p2", "up", 0.125);

		expect(calls[0]).toEqual(["pane", "split", "w1:p1", "--direction", "right", "--no-focus", "--cwd", "C:/project"]);
		expect(calls[1]).toEqual(["pane", "rename", "w1:p2", "researcher"]);
		expect(calls[2]).toEqual(["pane", "get", "w1:p2"]);
		expect(calls[3]).toContain("--source");
		expect(calls[3]).toContain("pi-durable-subagents");
		expect(calls[3]).toContain("model=test-provider/test-model");
		expect(calls[4]?.slice(0, 3)).toEqual(["pane", "run", "w1:p2"]);
		expect(calls[4]?.[3]).not.toContain(progress);
		expect(calls[4]?.[3]).not.toContain("\\x1b[3J\\x1b[2J\\x1b[H");
		expect(appended).toEqual([`${progress}\n`]);
		expect(calls[5]).toEqual(["pane", "split", "w1:p3", "--direction", "down", "--no-focus", "--cwd", "C:/project"]);
		expect(calls[7]).toEqual(["pane", "layout", "--pane", "w1:p1"]);
		expect(calls[8]).toEqual(["pane", "resize", "--direction", "up", "--amount", "0.125", "--pane", "w1:p2"]);
		await closeServer(renderer);
	});

	it("uses one persistent pane process to transport long append-only output off the command line", async () => {
		const payload = "Long assistant response. ".repeat(2_000);
		let command = "";
		let renderer: ChildProcessWithoutNullStreams | undefined;
		let rendered = "";
		const rendererScript = fileURLToPath(new URL("../src/herdr-pane-renderer.cjs", import.meta.url));
		const run = vi.fn(async (args: readonly string[]) => {
			if (args[0] === "pane" && args[1] === "run") {
				command = args[3] ?? "";
				const encodedValues = [...command.matchAll(/Buffer\.from\('([^']+)','base64'\)/g)].map((match) => match[1]!);
				const socketPath = encodedValues[1] === undefined ? undefined : Buffer.from(encodedValues[1], "base64").toString("utf8");
				if (socketPath !== undefined) {
					renderer = spawn(process.execPath, [rendererScript, socketPath], { stdio: ["pipe", "pipe", "pipe"] });
					renderer.stdout.setEncoding("utf8");
					renderer.stdout.on("data", (chunk: string) => { rendered += chunk; });
				}
			}
			return JSON.stringify({ result: { type: "ok" } });
		});
		const api = new HerdrCliApi(run);
		await api.appendText("w1:p3", payload);
		await api.appendText("w1:p3", "second update");
		const paneRuns = run.mock.calls.filter(([args]) => args[0] === "pane" && args[1] === "run");
		expect(paneRuns).toHaveLength(1);
		expect(command.length).toBeLessThan(500);
		expect(command).not.toContain(payload);
		expect(rendered).toBe(`${payload}\nsecond update\n`);
		await closeChild(renderer);
	});

	it("is enabled only in a Herdr-managed pane with a workspace ID", () => {
		expect(herdrApiFromEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" })).toBeDefined();
		expect(herdrApiFromEnvironment({ HERDR_ENV: "1" })).toBeUndefined();
		expect(herdrApiFromEnvironment({ HERDR_WORKSPACE_ID: "w1" })).toBeUndefined();
	});
});

describe("Herdr append-only agent panes", () => {
	it("formats a stable identity header and metadata with the configured model", () => {
		const model = { provider: "test-provider", modelId: "test-model" };
		expect(herdrMetadataForAgent("researcher", model, "high")).toEqual<HerdrMetadata>({
			displayAgent: "researcher",
			title: "researcher · test-provider/test-model · thinking high",
			tokens: { model: "test-provider/test-model", thinking: "high" },
		});
		expect(herdrHeaderText("researcher", model, "high"))
			.toBe("Durable agent: researcher\nModel: test-provider/test-model\nThinking: high");
	});

	it("appends full inputs and assistant text, completed tool calls, and config changes exactly once", async () => {
		const longInput = `Please inspect this. ${"input ".repeat(100)}`;
		const longResponse = `Complete response. ${"answer ".repeat(100)}`;
		const initialEntries = [
			entry("pi.user", 1, { role: "user", content: [{ type: "text", text: longInput }] }),
			entry("pi.assistant", 2, { role: "assistant", content: [
				{ type: "text", text: "I’ll inspect the files first." },
				{ type: "thinking", thinking: "not for the pane" },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "secret.txt", content: "x".repeat(600) } },
				{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "false" } },
			] }),
			entry("pi.tool-result", 3, { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "do not show read result" }], isError: false }),
			entry("pi.tool-result", 4, { role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [{ type: "text", text: "do not show bash result" }], isError: true }),
			entry("pi.assistant", 5, { role: "assistant", content: [{ type: "text", text: longResponse }] }),
		];
		const initialView = view({
			"pi.agent": { model: { provider: "test-provider", modelId: "test-model" }, thinkingLevel: "high" },
		}, initialEntries);
		let listener: ((call: any, context: any) => Promise<void>) | undefined;
		const watch = {
			value: initialView,
			start: (callback: typeof listener) => { listener = callback; },
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch;
		const conversation = {
			agent: vi.fn(async () => ({ model: { provider: "test-provider", modelId: "test-model" }, thinkingLevel: "high" })),
			watch: vi.fn(async () => watch),
		};
		const target: HerdrTarget = { tabId: "w1:t3", paneId: "w1:p3" };
		const service = {
			herdrTarget: vi.fn(async () => undefined),
			herdrOutputVersion: vi.fn(async () => undefined),
			setHerdrOutputVersion: vi.fn(async () => undefined),
			setHerdrTarget: vi.fn(async () => undefined),
			herdrAgents: vi.fn(async () => []),
		};
		const appendText = vi.fn(async (_paneId: string, _text: string) => undefined);
		const api: HerdrApi = {
			createPane: vi.fn(async () => target),
			getPane: vi.fn(async () => target),
			movePane: vi.fn(async () => target),
			paneLayout: vi.fn(async () => []),
			resizePane: vi.fn(async () => undefined),
			reportMetadata: vi.fn(async () => undefined),
			appendText,
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
		expect(api.reportMetadata).toHaveBeenCalledOnce();
		const firstAppend = appendText.mock.calls[0]?.[1] ?? "";
		expect(firstAppend).toContain("Durable agent: researcher\nModel: test-provider/test-model\nThinking: high");
		expect(firstAppend).toContain(longInput);
		expect(firstAppend).toContain("[assistant]\nI’ll inspect the files first.");
		expect(firstAppend).toContain(longResponse);
		expect(firstAppend).not.toContain("not for the pane");
		expect(firstAppend).not.toContain("do not show read result");
		expect(firstAppend).not.toContain("do not show bash result");
		expect(firstAppend).toContain('[tool] bash {"command":"false"} — failed');
		const readLine = firstAppend.split("\n").find((line) => line.startsWith("[tool] read "))!;
		const readArguments = readLine.slice("[tool] read ".length, -" — finished".length);
		expect(readArguments).toHaveLength(500);
		expect(readArguments.endsWith("…")).toBe(true);

		const nextEntries = [...initialEntries,
			entry("pi.user", 6, { role: "user", content: "Second task." }),
			entry("pi.assistant", 7, { role: "assistant", content: [{ type: "text", text: "I’ll handle that too." }] }),
		];
		const nextView = view({
			"pi.agent": { model: { provider: "openai", modelId: "gpt-next" }, thinkingLevel: "low" },
		}, nextEntries);
		await listener?.({ kind: "value", value: nextView, ops: [], retired: false }, BACKGROUND_CONTEXT);
		expect(appendText).toHaveBeenCalledTimes(2);
		expect(appendText.mock.calls[1]?.[1]).toBe([
			"[config] Model changed: openai/gpt-next",
			"[config] Thinking level changed: low",
			"[user input]\nSecond task.",
			"[assistant]\nI’ll handle that too.",
		].join("\n\n"));
		await listener?.({ kind: "value", value: nextView, ops: [], retired: false }, BACKGROUND_CONTEXT);
		expect(appendText).toHaveBeenCalledTimes(2);
		expect(api.reportMetadata).toHaveBeenCalledOnce();

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
			herdrOutputVersion: vi.fn(async () => undefined),
			setHerdrOutputVersion: vi.fn(async () => undefined),
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
			appendText: vi.fn(async () => undefined),
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
			herdrOutputVersion: vi.fn(async () => undefined),
			setHerdrOutputVersion: vi.fn(async () => undefined),
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
			appendText: vi.fn(async () => undefined),
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
			herdrOutputVersion: vi.fn(async () => undefined),
			setHerdrOutputVersion: vi.fn(async () => undefined),
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
			appendText: vi.fn(async () => undefined),
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
		expect(api.appendText).toHaveBeenLastCalledWith("w1:p4", expect.stringContaining("Durable agent: writer"));
		await monitor.close();
	});

	it("repositions a persisted pane below the main pane in the current tab", async () => {
		const stored: HerdrTarget = { tabId: "w1:t1", paneId: "w1:p4" };
		const watch = {
			value: view({ "pi.agent": { thinkingLevel: "medium" } }, [
				entry("pi.user", 7, { role: "user", content: "An already recorded request." }),
			]),
			start: vi.fn(),
			stop: vi.fn(async () => ({ kind: "stopped" as const })),
			closed: Promise.resolve({ kind: "stopped" as const }),
		} as unknown as ConversationWatch;
		const service = {
			herdrTarget: vi.fn(async () => stored),
			herdrOutputVersion: vi.fn(async () => undefined),
			setHerdrOutputVersion: vi.fn(async () => undefined),
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
			appendText: vi.fn(async () => undefined),
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
		expect(api.appendText).toHaveBeenCalledOnce();
		expect(api.appendText).toHaveBeenCalledWith(stored.paneId, "Durable agent: writer\nModel: no-model\nThinking: medium");
		expect(service.setHerdrOutputVersion).toHaveBeenCalledWith("writer", 1);
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
			herdrOutputVersion: vi.fn(async () => 1),
			setHerdrOutputVersion: vi.fn(async () => undefined),
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
			appendText: vi.fn(async () => undefined),
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
