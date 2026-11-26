import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	open: vi.fn(),
	setLimit: vi.fn(),
	close: vi.fn(),
	reportError: vi.fn(),
}));
vi.mock("../src/runtime.ts", async () => ({
	...(await import("../src/storage-path.ts")),
	openManagedSessionRuntime: mocks.open,
}));
import durableSubagents from "../src/index.ts";

async function extension() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const notify = vi.fn();
	let sessionFile = resolve("session-a.jsonl");
	const context = {
		mode: "print", hasUI: true, ui: { notify },
		sessionManager: { getSessionFile: () => sessionFile },
	} as unknown as ExtensionContext;
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: () => undefined,
		on: (name: string, handler: any) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	await durableSubagents(pi);
	const command = commands.get("agents");
	return {
		run: (args: string) => command.handler(args, context),
		complete: (prefix: string) => command.getArgumentCompletions(prefix),
		start: (reason = "resume") => handlers.get("session_start")({ reason }, context),
		stop: () => handlers.get("session_shutdown")({}, context),
		switchSession: () => { sessionFile = resolve("session-b.jsonl"); },
		notify,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.setLimit.mockResolvedValue(undefined);
	mocks.close.mockResolvedValue(undefined);
	mocks.open.mockImplementation(async (_pi, context, paneLimit) => {
		const monitor = {
			paneLimit,
			async setPaneLimit(limit: number) { await mocks.setLimit(limit); monitor.paneLimit = limit; },
		};
		return {
			sessionFile: context.sessionManager.getSessionFile(),
			service: { list: async () => [] }, herdrMonitor: monitor,
			close: mocks.close, reportDisplayError: mocks.reportError,
		};
	});
});

describe("pane budget command integration", () => {
	it("reports default without opening a runtime, validates and completes", async () => {
		const ext = await extension();
		await ext.run("panes");
		expect(ext.notify).toHaveBeenLastCalledWith(expect.stringContaining("budget: 3"), "info");
		expect(mocks.open).not.toHaveBeenCalled();
		await ext.run("panes -1");
		expect(ext.notify).toHaveBeenLastCalledWith(expect.stringContaining("nonnegative safe integer"), "error");
		expect(mocks.open).not.toHaveBeenCalled();
		expect(await ext.complete("pan")).toEqual([{ value: "panes", label: "panes" }]);
		expect(await ext.complete("panes ")).toContainEqual({ value: "panes 0", label: "0" });
		expect(await ext.complete("panes 3")).toEqual([{ value: "panes 3", label: "3" }]);
		expect(await ext.complete("panes 3 ")).toBeNull();
		await ext.run("help");
		expect(ext.notify).toHaveBeenLastCalledWith(expect.stringContaining("/agents panes [K]"), "info");
	});

	it("passes zero before opening and retains the setting across session runtime recreation", async () => {
		const ext = await extension();
		await ext.run("panes 0");
		expect(mocks.open.mock.calls.at(-1)?.[2]).toBe(0);
		expect(mocks.setLimit).toHaveBeenLastCalledWith(0);
		await ext.run("panes 5");
		expect(mocks.setLimit).toHaveBeenLastCalledWith(5);
		await ext.stop();
		ext.switchSession();
		await ext.start();
		expect(mocks.open.mock.calls.at(-1)?.[2]).toBe(5);
		await ext.stop();
		const replacement = await extension();
		await replacement.start("resume");
		expect(mocks.open.mock.calls.at(-1)?.[2]).toBe(5);
		await replacement.stop();
		const reloaded = await extension();
		await reloaded.start("reload");
		expect(mocks.open.mock.calls.at(-1)?.[2]).toBe(3);
		await reloaded.stop();
	});

	it("reconciles an existing monitor when startup resets the runtime preference", async () => {
		const ext = await extension();
		await ext.run("panes 5");
		await ext.start("startup");
		expect(mocks.setLimit).toHaveBeenLastCalledWith(3);
		expect(mocks.open).toHaveBeenCalledOnce();
		await ext.stop();
	});

	it("closes a pending open on shutdown instead of resurrecting a stale runtime", async () => {
		const ext = await extension();
		let resolveOpen!: (runtime: any) => void;
		mocks.open.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
		const starting = ext.start();
		await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
		const stopping = ext.stop();
		resolveOpen({ sessionFile: resolve("session-a.jsonl"), close: mocks.close });
		await Promise.all([starting, stopping]);
		expect(mocks.close).toHaveBeenCalledOnce();
		ext.switchSession();
		await ext.start();
		expect(mocks.open).toHaveBeenCalledTimes(2);
		await ext.stop();
	});

	it("uses the latest preference when a budget command arrives during open", async () => {
		const ext = await extension();
		let resolveOpen!: (runtime: any) => void;
		mocks.open.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
		const starting = ext.start();
		await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
		const resizing = ext.run("panes 0");
		const monitor = { paneLimit: 3, async setPaneLimit(limit: number) {
			await mocks.setLimit(limit); monitor.paneLimit = limit;
		} };
		resolveOpen({ sessionFile: resolve("session-a.jsonl"), herdrMonitor: monitor,
			close: mocks.close, reportDisplayError: mocks.reportError });
		await Promise.all([starting, resizing]);
		expect(monitor.paneLimit).toBe(0);
		await ext.stop();
	});

	it("surfaces display reconciliation errors without claiming success", async () => {
		const ext = await extension();
		mocks.setLimit.mockRejectedValueOnce(new Error("Herdr unavailable"));
		await ext.run("panes 0");
		expect(mocks.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "Herdr unavailable" }));
		expect(ext.notify).toHaveBeenLastCalledWith(expect.stringContaining("reconciliation failed"), "info");
		await ext.run("panes");
		expect(ext.notify).toHaveBeenLastCalledWith(expect.stringContaining("budget: 0"), "info");
		await ext.stop();
	});
});
