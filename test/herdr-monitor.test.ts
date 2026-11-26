import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { HerdrAgentMonitor, HerdrCliApi, HerdrPaneMissingError, HerdrPaneCreationRejectedError, herdrApiFromEnvironment, herdrHeaderText, herdrMetadataForAgent } from "../src/herdr-monitor.ts";
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

async function startFakeRenderer(socketPath: string, appended: string[], legacy = false): Promise<Server> {
	const server = createServer((socket) => {
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const request = JSON.parse(buffered.slice(0, newline)) as { type: string; id: string; text?: string };
			if (legacy && request.type === "reset") {
				socket.end(`${JSON.stringify({ id: request.id, ok: false, error: "invalid append message" })}\n`);
				return;
			}
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

async function waitForChildOutput(
	child: ChildProcessWithoutNullStreams,
	getOutput: () => string,
	minimumLength: number,
): Promise<void> {
	if (getOutput().length >= minimumLength) return;
	await new Promise<void>((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			child.stdout.removeListener("data", onData);
			child.removeListener("exit", onExit);
			if (error === undefined) resolve();
			else reject(error);
		};
		const onData = () => {
			if (getOutput().length >= minimumLength) finish();
		};
		const onExit = () => finish(new Error("Herdr pane renderer exited before all output was received."));
		const timeout = setTimeout(() => finish(new Error("Timed out waiting for Herdr pane output.")), 1_000);
		child.stdout.on("data", onData);
		child.once("exit", onExit);
		onData();
	});
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
		const bootstrap = calls.find((args) => args[0] === "pane" && args[1] === "run")!;
		expect(bootstrap.slice(0, 3)).toEqual(["pane", "run", "w1:p2"]);
		expect(bootstrap[3]).not.toContain(progress);
		expect(bootstrap[3]).not.toContain("\\x1b[3J\\x1b[2J\\x1b[H");
		expect(appended).toEqual([`${progress}\n`]);
		expect(calls[6]).toEqual(["pane", "split", "w1:p3", "--direction", "down", "--no-focus", "--cwd", "C:/project"]);
		expect(calls[8]).toEqual(["pane", "layout", "--pane", "w1:p1"]);
		expect(calls[9]).toEqual(["pane", "resize", "--direction", "up", "--amount", "0.125", "--pane", "w1:p2"]);
		await closeServer(renderer);
	});

	it("uses one persistent pane process to transport long append-only output off the command line", async () => {
		const payload = "Long assistant response. ".repeat(2_000);
		const expectedRendered = `${payload}\nsecond update\n\x1b[3J\x1b[2J\x1b[Hnew occupant\n`;
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
		await api.resetText("w1:p3");
		await api.appendText("w1:p3", "new occupant");
		const paneRuns = run.mock.calls.filter(([args]) => args[0] === "pane" && args[1] === "run");
		expect(paneRuns).toHaveLength(1);
		expect(command.length).toBeLessThan(500);
		expect(command).not.toContain(payload);
		if (renderer === undefined) throw new Error("Herdr pane renderer was not started.");
		await waitForChildOutput(renderer, () => rendered, expectedRendered.length);
		expect(rendered).toBe(expectedRendered);
		await closeChild(renderer);
	});

	it("distinguishes failure to start the CLI from a split with an unknown outcome", async () => {
		const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
		const run = vi.fn(async (_args: readonly string[]): Promise<string> => { throw missing; });
		const api = new HerdrCliApi(run);
		await expect(api.createPane("C:/project", "agent")).rejects.toBeInstanceOf(HerdrPaneCreationRejectedError);
		const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
		run.mockRejectedValueOnce(timeout);
		await expect(api.createPane("C:/project", "agent")).rejects.toBe(timeout);
	});

	it("uses returned pane IDs when a move changes identity and closes explicit panes", async () => {
		const run = vi.fn(async () => JSON.stringify({ result: { pane: { tab_id: "w2:t1", pane_id: "w2:p9" } } }));
		const api = new HerdrCliApi(run);
		await expect(api.movePane("w1:p2", "w2:t1", "w2:p1", "agent", "right")).resolves.toEqual({ tabId: "w2:t1", paneId: "w2:p9" });
		expect(run).toHaveBeenNthCalledWith(2, ["pane", "rename", "w2:p9", "agent"]);
		await api.closePane("w2:p9");
		expect(run).toHaveBeenLastCalledWith(["pane", "close", "w2:p9"]);
	});

	it("requires a successful workspace inventory to distinguish a missing pane from a transport failure", async () => {
		const previous = process.env.HERDR_WORKSPACE_ID;
		process.env.HERDR_WORKSPACE_ID = "w1";
		try {
			const failure = new Error("server unavailable");
			const run = vi.fn(async (_args: readonly string[]): Promise<string> => { throw failure; });
			const api = new HerdrCliApi(run);
			await expect(api.getPane("w1:p2")).rejects.toBe(failure);
			run.mockRejectedValueOnce(failure).mockResolvedValueOnce(JSON.stringify({ result: { panes: [] } }));
			await expect(api.getPane("w1:p2")).rejects.toBeInstanceOf(HerdrPaneMissingError);
			run.mockRejectedValueOnce(failure).mockResolvedValueOnce(JSON.stringify({ result: { panes: [{ pane_id: "w1:p2" }] } }));
			await expect(api.getPane("w1:p2")).rejects.toBe(failure);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = previous;
		}
	});

	it("clears through append when an already-running legacy renderer does not understand reset", async () => {
		const appended: string[] = [];
		let renderer: Server | undefined;
		const run = vi.fn(async (args: readonly string[]) => {
			if (args[1] === "run") {
				const encoded = [...args[3]!.matchAll(/Buffer\.from\('([^']+)','base64'\)/g)][1]![1]!;
				renderer = await startFakeRenderer(Buffer.from(encoded, "base64").toString("utf8"), appended, true);
			}
			return "{}";
		});
		try {
			const api = new HerdrCliApi(run);
			await api.appendText("legacy-pane", "old occupant");
			await api.resetText("legacy-pane");
			await api.appendText("legacy-pane", "new occupant");
			expect(appended).toEqual(["old occupant\n", "\x1b[3J\x1b[2J\x1b[H", "new occupant\n"]);
			expect(run.mock.calls.filter(([args]) => args[1] === "run")).toHaveLength(1);
		} finally { await closeServer(renderer); }
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
			entries: vi.fn(async () => ({ items: initialView.entries })),
		};
		const target: HerdrTarget = { tabId: "w1:t3", paneId: "w1:p3" };
		const service = {
			herdrPaneCreationPending: vi.fn(async () => false),
			setHerdrPaneCreationPending: vi.fn(async () => undefined),
			herdrTarget: vi.fn(async () => undefined),
			herdrOutputVersion: vi.fn(async () => undefined),
			setHerdrOutputVersion: vi.fn(async () => undefined),
			setHerdrTarget: vi.fn(async () => undefined),
			herdrDisplayAgents: vi.fn(async () => [{ name: "researcher", conversationId: "conversation-1", active: true, workStart: 1, workKey: "first" }]),
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
			resetText: vi.fn(async () => undefined),
			closePane: vi.fn(async () => undefined),
		};
		const monitor = new HerdrAgentMonitor({
			api,
			cwd: "C:/project",
			harness: { conversation: vi.fn(async () => conversation) } as never,
			service: service as never,
		});

		await monitor.trackAgent("researcher", "conversation-1" as never);
		expect(api.createPane).toHaveBeenCalledWith("C:/project", "researcher", undefined, "right");
		expect(service.setHerdrTarget).toHaveBeenCalledWith("researcher", target, true);
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
		await monitor.refresh();
		expect(appendText).toHaveBeenCalledTimes(2);
		expect(appendText.mock.calls[1]?.[1]).toBe([
			"[config] Model changed: openai/gpt-next",
			"[config] Thinking level changed: low",
			"[user input]\nSecond task.",
			"[assistant]\nI’ll handle that too.",
		].join("\n\n"));
		await listener?.({ kind: "value", value: nextView, ops: [], retired: false }, BACKGROUND_CONTEXT);
		expect(appendText).toHaveBeenCalledTimes(2);
		expect(api.reportMetadata).toHaveBeenCalledTimes(2);

		await monitor.close();
		expect(watch.stop).toHaveBeenCalledOnce();
	});

});
