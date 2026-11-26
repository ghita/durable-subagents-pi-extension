import { describe, expect, it, vi } from "vitest";
import type { ConversationId, ConversationView, ConversationWatch, EntryId } from "@earendil-works/pi-durable";
import { HerdrAgentMonitor, HerdrPaneMissingError, HerdrPaneCreationRejectedError, type HerdrApi } from "../src/herdr-monitor.ts";
import type { HerdrTarget } from "../src/agent-service.ts";

function user(id: number, text: string) { return { kind: "pi.user", id, model: [{ role: "user", content: text }] }; }
function assistant(id: number, text: string) { return { kind: "pi.assistant", id, model: [{ role: "assistant", content: [{ type: "text", text }] }] }; }
function view(entries: unknown[] = [], before?: number): ConversationView {
	return { conversation: {}, entries, before, docs: { "pi.agent": { model: { provider: "test", modelId: "model" }, thinkingLevel: "high" } } } as never;
}

function setup(limit = 3) {
	const records = new Map<string, { name: string; conversationId: ConversationId; active: boolean; workStart?: EntryId; workKey?: string; workOrder?: number }>();
	const targets = new Map<string, HerdrTarget>();
	const outputVersions = new Map<string, number | undefined>();
	const panes = new Map<string, HerdrTarget>();
	const views = new Map<string, ConversationView>();
	const history = new Map<string, ConversationView["entries"]>();
	const listeners = new Map<string, (call: any) => Promise<void>>();
	const stops: ReturnType<typeof vi.fn>[] = [];
	const output = new Map<string, string>();
	const state = { creationPending: false };
	const service = {
		herdrPaneCreationPending: vi.fn(async () => state.creationPending),
		setHerdrPaneCreationPending: vi.fn(async (pending: boolean) => { state.creationPending = pending; }),
		herdrDisplayAgents: vi.fn(async () => [...records.values()].map((record) => ({ ...record }))),
		herdrTarget: vi.fn(async (name: string) => targets.get(name)),
		herdrOutputVersion: vi.fn(async (name: string) => outputVersions.has(name) ? outputVersions.get(name) : targets.has(name) ? 1 : undefined),
		setHerdrOutputVersion: vi.fn(async (name: string, version: number) => { outputVersions.set(name, version); }),
		setHerdrTarget: vi.fn(async (name: string, target?: HerdrTarget, completePaneCreation = false) => {
			if (completePaneCreation) state.creationPending = false;
			const previous = targets.get(name);
			if (target === undefined || previous?.paneId !== target.paneId || previous?.tabId !== target.tabId) outputVersions.set(name, undefined);
			if (target === undefined) targets.delete(name); else targets.set(name, target);
		}),
	};
	let paneId = 1;
	const api: HerdrApi = {
		createPane: vi.fn(async () => {
			const target = { tabId: "w1:t1", paneId: `w1:p${++paneId}` };
			panes.set(target.paneId, target);
			return target;
		}),
		getPane: vi.fn(async (id) => {
			const pane = panes.get(id);
			if (pane === undefined) throw new HerdrPaneMissingError("missing");
			return pane;
		}),
		movePane: vi.fn(async (id, tab) => {
			const target = { paneId: id, tabId: tab }; panes.set(id, target); return target;
		}),
		closePane: vi.fn(async (id) => { panes.delete(id); output.delete(id); }),
		paneLayout: vi.fn(async () => []),
		resizePane: vi.fn(async () => undefined),
		reportMetadata: vi.fn(async () => undefined),
		appendText: vi.fn(async (id, text) => { output.set(id, (output.get(id) ?? "") + text + "\n"); }),
		resetText: vi.fn(async (id) => { output.set(id, ""); }),
	};
	const makeMonitor = () => new HerdrAgentMonitor({
		api, currentPane: { tabId: "w1:t1", paneId: "w1:p1" }, paneLimit: limit,
		cwd: "C:/project", service: service as never, onError: vi.fn(),
		harness: { conversation: async (id: string) => ({
			agent: async () => ({ model: { provider: "test", modelId: "model" }, thinkingLevel: "high" }),
			watch: async () => {
				const stop = vi.fn(async () => ({ kind: "stopped" })); stops.push(stop);
				return { value: views.get(id), start: (fn: any) => listeners.set(id, fn), stop } as unknown as ConversationWatch;
			},
			entries: async (query: { minEntryId: number; maxEntryId: number }, size: number, cursor?: string) => {
				const all = (history.get(id) ?? []).filter((entry) => entry.id >= query.minEntryId && entry.id <= query.maxEntryId);
				const offset = Number(cursor ?? 0);
				return { items: all.slice(offset, offset + size), next: offset + size < all.length ? String(offset + size) : undefined };
			},
		}) } as never,
	});
	const monitor = makeMonitor();
	function add(name: string, active = true, entries: unknown[] = [user(1, `${name} request`), assistant(2, `${name} result`)]) {
		records.set(name, { name, conversationId: name as unknown as ConversationId, active, workStart: 1 as EntryId, workKey: `${name}-1` });
		views.set(name, view(entries)); history.set(name, entries as never);
	}
	async function update(name: string, entries: unknown[], before?: number) {
		views.set(name, view(entries, before));
		if (before === undefined) history.set(name, entries as never);
		await listeners.get(name)?.({ kind: "value", value: views.get(name) });
		await monitor.refresh();
	}
	function shown() { return [...targets.keys()].sort(); }
	return { monitor, makeMonitor, state, api, service, records, targets, outputVersions, panes, views, history, output, stops, add, update, shown };
}

describe("bounded Herdr display slots", () => {
	it("bounds concurrent allocation without excluding overflow agents from observation", async () => {
		const f = setup();
		for (let i = 0; i < 20; i++) f.add(`agent-${i}`);
		await Promise.all([...f.records.values()].map((agent) => f.monitor.trackAgent(agent.name, agent.conversationId)));
		expect(f.panes.size).toBe(3);
		expect(f.api.createPane).toHaveBeenCalledTimes(3);
		expect(f.stops).toHaveLength(20);
		expect(f.shown()).toEqual(["agent-0", "agent-1", "agent-2"]);
		expect(f.api.createPane).toHaveBeenNthCalledWith(1, "C:/project", "agent-0", "w1:p1", "right");
		expect(f.api.createPane).toHaveBeenNthCalledWith(2, "C:/project", "agent-1", "w1:p2", "down");
		await f.monitor.close();
		expect(f.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
	});

	it("retains active slots, skips finished overflow, and replaces idle output with FIFO current-work replay", async () => {
		const f = setup(1);
		f.add("a"); f.add("b"); f.add("c", true, [user(1, "old c task"), assistant(2, "old c result"), user(3, "new c task"), assistant(4, "new c progress")]);
		f.records.get("c")!.workStart = 3 as EntryId;
		await f.monitor.refresh();
		f.records.get("b")!.active = false;
		await f.monitor.refresh();
		expect(f.shown()).toEqual(["a"]);
		f.records.get("a")!.active = false;
		await f.monitor.refresh();
		expect(f.shown()).toEqual(["c"]);
		expect(f.api.createPane).toHaveBeenCalledTimes(1);
		expect(f.api.resetText).toHaveBeenCalledWith("w1:p2");
		const text = f.output.get("w1:p2")!;
		expect(text).toContain("Durable agent: c");
		expect(text).toContain("new c task"); expect(text).toContain("new c progress");
		expect(text).not.toContain("old c"); expect(text).not.toContain("a request");
		await f.monitor.close();
	});

	it("retains idle results and returning agents join behind existing waiters", async () => {
		const f = setup(1); f.add("a");
		await f.monitor.refresh();
		f.records.get("a")!.active = false;
		await f.monitor.refresh();
		expect(f.shown()).toEqual(["a"]); expect(f.api.closePane).not.toHaveBeenCalled();
		f.add("b"); await f.monitor.refresh();
		f.add("c"); await f.monitor.refresh();
		f.records.get("a")!.active = true; f.records.get("a")!.workKey = "a-2";
		await f.monitor.refresh();
		f.records.get("b")!.active = false; await f.monitor.refresh();
		expect(f.shown()).toEqual(["c"]);
		f.records.get("c")!.active = false; await f.monitor.refresh();
		expect(f.shown()).toEqual(["a"]);
		await f.monitor.close();
	});

	it("replaces the longest-idle display first", async () => {
		const f = setup(2); f.add("a"); f.add("b"); await f.monitor.refresh();
		f.records.get("b")!.active = false; await f.monitor.refresh();
		f.records.get("a")!.active = false; await f.monitor.refresh();
		f.add("c"); await f.monitor.refresh();
		expect(f.shown()).toEqual(["a", "c"]);
		await f.monitor.close();
	});

	it("shrinks idle first, then newest active assignments; zero closes panes, growing preserves waiting priority", async () => {
		const f = setup(); for (const name of ["a", "b", "c", "d"]) f.add(name);
		await f.monitor.refresh(); f.records.get("a")!.active = false; await f.monitor.refresh();
		// d replaces a; then shrink drops the newest assignment (d), keeping b.
		await f.monitor.setPaneLimit(1);
		expect(f.shown()).toEqual(["b"]);
		await f.monitor.setPaneLimit(2);
		expect(f.shown()).toEqual(["b", "c"]);
		await f.monitor.setPaneLimit(0); expect(f.panes.size).toBe(0); expect(f.monitor.paneLimit).toBe(0);
		expect([...f.records.values()].filter((r) => r.active)).toHaveLength(3);
		await f.monitor.setPaneLimit(3); expect(f.shown()).toEqual(["b", "c", "d"]);
		await f.monitor.close();
	});

	it("closes idle panes before active displays when shrinking", async () => {
		const f = setup(); f.add("a"); f.add("b"); f.add("c"); await f.monitor.refresh();
		f.records.get("b")!.active = false; await f.monitor.refresh();
		await f.monitor.setPaneLimit(2);
		expect(f.shown()).toEqual(["a", "c"]);
		await f.monitor.close();
	});

	it("reconciles all legacy panes before allocation, keeps active first, and ignores unrelated panes", async () => {
		const f = setup(2);
		for (let i = 0; i < 8; i++) {
			const name = `a${i}`; f.add(name, i === 6 || i === 7);
			const pane = { tabId: "w1:t0", paneId: `old-${i}` }; f.targets.set(name, pane); f.panes.set(pane.paneId, pane);
		}
		const unrelated = { tabId: "w1:t1", paneId: "unrelated" }; f.panes.set(unrelated.paneId, unrelated);
		await f.monitor.attachPersistedAgents();
		expect(f.shown()).toEqual(["a6", "a7"]);
		expect(f.panes.size).toBe(3); expect(f.panes.has("unrelated")).toBe(true);
		expect(f.api.createPane).not.toHaveBeenCalled(); expect(f.api.closePane).toHaveBeenCalledTimes(6);
		expect([...f.targets.values()].every((p) => p.tabId === "w1:t1")).toBe(true);
		await f.monitor.close();
	});

	it("does not create transient panes when initialized with zero and imports idle legacy displays for cleanup", async () => {
		const f = setup(0); f.add("a"); f.add("idle", false);
		const pane = { tabId: "w1:t1", paneId: "old" }; f.targets.set("idle", pane); f.panes.set("old", pane);
		await f.monitor.refresh(); expect(f.panes.size).toBe(0); expect(f.api.createPane).not.toHaveBeenCalled();
		await f.monitor.setPaneLimit(1); expect(f.shown()).toEqual(["a"]);
		await f.monitor.close();
	});

	it("recreates a positively missing pane, but not on generic get/close failures", async () => {
		const f = setup(1); f.add("a"); f.add("b"); await f.monitor.refresh();
		vi.mocked(f.api.getPane).mockRejectedValueOnce(new Error("CLI timed out"));
		await f.monitor.refresh(); expect(f.api.createPane).toHaveBeenCalledTimes(1);
		f.panes.delete("w1:p2"); await f.monitor.refresh();
		expect(f.api.createPane).toHaveBeenCalledTimes(2);
		vi.mocked(f.api.closePane).mockRejectedValue(new Error("close failed"));
		await f.monitor.setPaneLimit(0); expect(f.panes.size).toBe(1);
		await f.monitor.setPaneLimit(1); expect(f.api.createPane).toHaveBeenCalledTimes(2);
		await f.monitor.close();
	});

	it("suspends further splits after an uncertain create outcome instead of leaking replacements", async () => {
		const f = setup(); f.add("a"); f.add("b");
		vi.mocked(f.api.createPane).mockRejectedValue(new Error("split timed out"));
		await f.monitor.refresh(); await f.monitor.refresh(); await f.monitor.setPaneLimit(5);
		expect(f.api.createPane).toHaveBeenCalledTimes(1);
		await f.monitor.close();
	});

	it("does not emit new identity/output until reset succeeds and never writes stale occupant output", async () => {
		const f = setup(1); f.add("a"); f.add("b"); await f.monitor.refresh();
		f.records.get("a")!.active = false;
		vi.mocked(f.api.resetText).mockRejectedValueOnce(new Error("reset failed"));
		await f.monitor.refresh();
		expect(f.output.get("w1:p2")).not.toContain("Durable agent: b");
		await f.update("a", [user(1, "a request"), assistant(3, "late a output")]);
		const text = f.output.get("w1:p2")!;
		expect(text).toContain("Durable agent: b"); expect(text).not.toContain("late a output");
		await f.monitor.close();
	});

	it("replays beyond the watch window and includes all steered inputs in current work", async () => {
		const f = setup(1); f.add("a"); f.add("b"); await f.monitor.refresh();
		const entries = [user(1, "old completed task"), assistant(2, "old answer"), user(3, "current input")];
		for (let id = 4; id < 650; id++) entries.push(assistant(id, `line ${id}`) as never);
		entries.push(user(650, "steer this task"), assistant(651, "latest progress") as never);
		f.records.get("b")!.workStart = 3 as EntryId;
		f.history.set("b", entries as never);
		await f.update("b", entries.slice(-50), 601);
		f.records.get("a")!.active = false; await f.monitor.refresh();
		const text = f.output.get("w1:p2")!;
		expect(text).toContain("current input"); expect(text).toContain("line 4"); expect(text).toContain("steer this task");
		expect(text).not.toContain("old completed task"); expect(text).not.toContain("old answer");
		await f.monitor.close();
	});

	it("does not replay old history while a queued input has no committed entry boundary yet", async () => {
		const f = setup(1); f.add("a", true, [user(1, "previous task"), assistant(2, "previous answer")]);
		f.records.get("a")!.workStart = undefined;
		await f.monitor.refresh(); expect(f.output.get("w1:p2")).not.toContain("previous task");
		f.records.get("a")!.workStart = 3 as EntryId;
		await f.update("a", [user(1, "previous task"), assistant(2, "previous answer"), user(3, "new queued input")]);
		expect(f.output.get("w1:p2")).toContain("new queued input");
		expect(f.output.get("w1:p2")).not.toContain("previous task");
		await f.monitor.close();
	});

	it("yields to an older waiter even if completion and new work both happen between polls", async () => {
		const f = setup(1); f.add("a"); f.add("b");
		f.records.get("a")!.workOrder = 100; f.records.get("b")!.workOrder = 200;
		await f.monitor.refresh();
		// The service persisted the end of a's first period and accepted its next
		// instruction before the monitor got another activity snapshot.
		f.records.get("a")!.workKey = "a-2"; f.records.get("a")!.workOrder = 300;
		await f.monitor.refresh(); expect(f.shown()).toEqual(["b"]);
		f.records.get("b")!.active = false; await f.monitor.refresh();
		expect(f.shown()).toEqual(["a"]);
		await f.monitor.close();
	});

	it("does not let a retained idle display bypass work accepted before its next instruction", async () => {
		const f = setup(1); f.add("a"); f.records.get("a")!.workOrder = 100;
		await f.monitor.refresh(); f.records.get("a")!.active = false; await f.monitor.refresh();
		f.add("b"); f.records.get("b")!.workOrder = 200;
		f.records.get("a")!.active = true; f.records.get("a")!.workKey = "a-2"; f.records.get("a")!.workOrder = 300;
		await f.monitor.refresh(); expect(f.shown()).toEqual(["b"]);
		await f.monitor.close();
	});

	it("does not duplicate a returning displayed agent when another idle slot is older", async () => {
		const f = setup(2); f.add("a"); f.add("idle"); await f.monitor.refresh();
		f.records.get("idle")!.active = false; await f.monitor.refresh();
		f.records.get("a")!.workKey = "a-2";
		await f.monitor.refresh();
		expect(f.shown()).toEqual(["a", "idle"]);
		expect(f.api.createPane).toHaveBeenCalledTimes(2);
		expect(f.api.resetText).not.toHaveBeenCalled();
		await f.monitor.close();
	});

	it("uses durable acceptance order rather than registry order on initial attachment", async () => {
		const f = setup(1); f.add("older-registration"); f.add("newer-registration");
		f.records.get("older-registration")!.workOrder = 200;
		f.records.get("newer-registration")!.workOrder = 100;
		await f.monitor.refresh();
		expect(f.shown()).toEqual(["newer-registration"]);
		await f.monitor.close();
	});

	it("clears and replays an interrupted handoff whose occupant has no committed output version", async () => {
		const f = setup(1); f.add("replacement");
		const pane = { tabId: "w1:t1", paneId: "interrupted" };
		f.targets.set("replacement", pane); f.panes.set(pane.paneId, pane);
		f.output.set(pane.paneId, "previous occupant's screen and scrollback");
		vi.mocked(f.service.herdrOutputVersion).mockResolvedValue(undefined as never);
		await f.monitor.attachPersistedAgents();
		expect(f.api.resetText).toHaveBeenCalledWith("interrupted");
		expect(f.output.get("interrupted")).toContain("Durable agent: replacement");
		expect(f.output.get("interrupted")).toContain("replacement request");
		expect(f.output.get("interrupted")).not.toContain("previous occupant");
		expect(f.api.createPane).not.toHaveBeenCalled();
		await f.monitor.close();
	});

	it("invalidates an old same-pane alias before a handoff, so an interrupted reset remains safe on resume", async () => {
		const f = setup(1); f.add("a"); f.add("b", false); await f.monitor.refresh();
		const pane = f.targets.get("a")!;
		// Simulate a stale alias left by a failed prior source-association cleanup.
		f.targets.set("b", pane); f.outputVersions.set("b", 1);
		f.records.get("a")!.active = false; f.records.get("b")!.active = true;
		vi.mocked(f.api.resetText).mockRejectedValueOnce(new Error("interrupted before reset"));
		await f.monitor.refresh();
		expect(f.outputVersions.get("b")).toBe(0);
		expect(f.output.get(pane.paneId)).toContain("a request");
		await f.monitor.close();
		const resumed = f.makeMonitor(); await resumed.refresh();
		expect(f.output.get(pane.paneId)).toContain("Durable agent: b");
		expect(f.output.get(pane.paneId)).not.toContain("a request");
		await resumed.close();
	});

	it("deduplicates associations left by a crash during handoff without double-counting or closing a shared target", async () => {
		const f = setup(1); f.add("previous", false); f.add("replacement");
		const pane = { tabId: "w1:t1", paneId: "shared" };
		f.targets.set("previous", pane); f.targets.set("replacement", pane); f.panes.set(pane.paneId, pane);
		await f.monitor.refresh();
		expect(f.shown()).toEqual(["replacement"]);
		expect(f.api.createPane).not.toHaveBeenCalled(); expect(f.api.closePane).not.toHaveBeenCalled();
		expect(f.output.get("shared")).toContain("Durable agent: replacement");
		await f.monitor.close();
	});

	it("recovers after a definitely rejected split without leaving a permanent reservation", async () => {
		const f = setup(1); f.add("a");
		vi.mocked(f.api.createPane).mockRejectedValueOnce(new HerdrPaneCreationRejectedError("CLI missing"));
		await f.monitor.refresh(); expect(f.state.creationPending).toBe(false);
		await f.monitor.refresh(); expect(f.shown()).toEqual(["a"]);
		await f.monitor.close();
	});

	it("recovers pending tool arguments on resume without replaying already displayed text", async () => {
		const f = setup(1);
		const call = { kind: "pi.assistant", id: 2, model: [{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.ts" } }] }] };
		f.add("a", true, [user(1, "already displayed input"), call]);
		const pane = { tabId: "w1:t1", paneId: "resumed" }; f.targets.set("a", pane); f.panes.set(pane.paneId, pane);
		await f.monitor.refresh(); expect(f.api.appendText).not.toHaveBeenCalled();
		await f.update("a", [user(1, "already displayed input"), call, { kind: "pi.tool-result", id: 3, model: [{ role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false }] }]);
		expect(f.output.get("resumed")).toContain('[tool] read {"path":"file.ts"} — finished');
		expect(f.output.get("resumed")).not.toContain("already displayed input");
		await f.monitor.close();
	});

	it("persists uncertain creation across monitor restart instead of repeating a split", async () => {
		const f = setup(1); f.add("a");
		vi.mocked(f.api.createPane).mockRejectedValue(new Error("timeout after split"));
		await f.monitor.refresh(); expect(f.state.creationPending).toBe(true);
		await f.monitor.close();
		const resumed = f.makeMonitor(); await resumed.refresh(); await resumed.refresh();
		expect(f.api.createPane).toHaveBeenCalledTimes(1);
		await resumed.close();
	});

	it("does not allocate before all persisted pane associations can be inspected", async () => {
		const f = setup(3); f.add("a"); f.add("b");
		const pane = { tabId: "w1:t1", paneId: "stored-a" }; f.targets.set("a", pane); f.panes.set(pane.paneId, pane);
		vi.mocked(f.service.herdrTarget).mockRejectedValueOnce(new Error("association read failed"));
		await f.monitor.refresh();
		expect(f.api.createPane).not.toHaveBeenCalled(); expect(f.stops).toHaveLength(1);
		await f.monitor.refresh();
		expect(f.panes.size).toBe(2); expect(f.api.createPane).toHaveBeenCalledTimes(1);
		await f.monitor.close();
	});

	it("counts a created pane during persistence failure and retries its association before further allocation", async () => {
		const f = setup(1); f.add("a"); f.add("b");
		vi.mocked(f.service.setHerdrTarget).mockRejectedValueOnce(new Error("storage unavailable"));
		await f.monitor.refresh(); expect(f.panes.size).toBe(1); expect(f.state.creationPending).toBe(true);
		await f.monitor.refresh();
		expect(f.api.createPane).toHaveBeenCalledTimes(1);
		expect(f.state.creationPending).toBe(false); expect(f.shown()).toEqual(["a"]);
		await f.monitor.close();
	});

	it("does not split when a durable creation reservation cannot be written", async () => {
		const f = setup(1); f.add("a");
		vi.mocked(f.service.setHerdrPaneCreationPending).mockRejectedValueOnce(new Error("storage unavailable"));
		await f.monitor.refresh(); expect(f.api.createPane).not.toHaveBeenCalled();
		await f.monitor.refresh(); expect(f.api.createPane).toHaveBeenCalledTimes(1);
		await f.monitor.close();
	});

	it("returns a manually moved tracked pane to its tab without allocating a replacement", async () => {
		const f = setup(1); f.add("a"); await f.monitor.refresh();
		f.panes.set("w1:p2", { paneId: "w1:p2", tabId: "w1:t9" });
		await f.monitor.refresh();
		expect(f.api.movePane).toHaveBeenLastCalledWith("w1:p2", "w1:t1", "w1:p1", "a", "right");
		expect(f.api.createPane).toHaveBeenCalledTimes(1);
		await f.monitor.close();
	});

	it("reflows restored panes beside the main pane, then below the preceding display", async () => {
		const f = setup(2); f.add("a"); f.add("b");
		for (const name of ["a", "b"]) {
			const pane = { tabId: "w1:t9", paneId: `old-${name}` }; f.targets.set(name, pane); f.panes.set(pane.paneId, pane);
		}
		await f.monitor.refresh();
		expect(f.api.movePane).toHaveBeenNthCalledWith(1, "old-a", "w1:t1", "w1:p1", "a", "right");
		expect(f.api.movePane).toHaveBeenNthCalledWith(2, "old-b", "w1:t1", "old-a", "b", "down");
		await f.monitor.close();
	});

	it("equalizes display rows after topology changes but does not keep overriding manual resizing", async () => {
		const f = setup(3); for (const name of ["a", "b", "c"]) f.add(name);
		const rows = (heights: number[]) => heights.map((height, index) => ({
			paneId: `w1:p${index + 2}`, rect: { x: 100, y: heights.slice(0, index).reduce((a, b) => a + b, 0), width: 100, height },
		}));
		vi.mocked(f.api.paneLayout).mockResolvedValueOnce(rows([30, 15, 15])).mockResolvedValue(rows([20, 20, 20]));
		await f.monitor.refresh();
		expect(f.api.resizePane).toHaveBeenCalledExactlyOnceWith("w1:p2", "up", expect.closeTo(1 / 6, 5));
		const count = vi.mocked(f.api.paneLayout).mock.calls.length;
		await f.monitor.refresh(); expect(f.api.paneLayout).toHaveBeenCalledTimes(count);
		await f.monitor.close();
	});

	it("never treats the main Pi pane as an owned display even if an association is corrupt", async () => {
		const f = setup(0); f.add("a");
		f.targets.set("a", { tabId: "w1:t1", paneId: "w1:p1" });
		await f.monitor.refresh();
		expect(f.api.closePane).not.toHaveBeenCalled(); expect(f.api.movePane).not.toHaveBeenCalled();
		expect(f.shown()).toEqual([]);
		await f.monitor.close();
	});

	it("validates limits without mutating state and leaves panes alive on shutdown for resume", async () => {
		const f = setup(); f.add("a"); await f.monitor.refresh();
		for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => f.monitor.setPaneLimit(value)).toThrow();
		expect(f.monitor.paneLimit).toBe(3);
		await f.monitor.close(); await f.monitor.refresh();
		expect(f.panes.size).toBe(1); expect(f.api.closePane).not.toHaveBeenCalled();
	});
});
