import { describe, expect, it } from "vitest";
import { aggregateUsage, orderStatsRows } from "../src/agent-service.ts";
import { parseAgentsCommand } from "../src/command-parser.ts";
import { uniqueAgentName, validateAgentName } from "../src/names.ts";
import { durableDatabasePath, requireSessionFile } from "../src/storage-path.ts";

const usage = (input: number, output: number, cost: number) => ({
	input,
	output,
	cacheRead: 2,
	cacheWrite: 3,
	totalTokens: input + output + 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("durable subagent domain helpers", () => {
	it("derives a deterministic adjacent sidecar from a persisted transcript", () => {
		expect(durableDatabasePath("C:/sessions/work/session-abc.jsonl")).toBe("C:\\sessions\\work\\session-abc.durable.sqlite");
		expect(durableDatabasePath("C:/sessions/work/pi-session")).toBe("C:\\sessions\\work\\pi-session.durable.sqlite");
	});

	it("requires a persisted Pi session instead of falling back to temporary storage", () => {
		expect(() => requireSessionFile(undefined)).toThrow(/Persistent Pi session required/);
		expect(() => durableDatabasePath("  ")).toThrow(/Persistent Pi session required/);
	});

	it("increments collision suffixes across registered idle and active names", () => {
		const registered = { analyst: {}, "analyst-2": {}, "analyst-4": {} };
		expect(uniqueAgentName(" analyst ", registered)).toBe("analyst-3");
		expect(uniqueAgentName("new agent", registered)).toBe("new agent");
		expect(() => validateAgentName("\n")).toThrow(/meaningful/);
		expect(() => validateAgentName("__proto__")).toThrow(/reserved/);
	});

	it("parses explicit slash operations and preserves task/message text", () => {
		expect(parseAgentsCommand('spawn "research helper" --preset researcher -- inspect files and report')).toEqual({
			action: "spawn",
			name: "research helper",
			presetId: "researcher",
			message: "inspect files and report",
		});
		expect(parseAgentsCommand("spawn --preset researcher -- run the task")).toEqual({
			action: "spawn",
			presetId: "researcher",
			message: "run the task",
		});
		expect(parseAgentsCommand('spawn worker -- search for an unmatched quote " in code')).toEqual({
			action: "spawn",
			name: "worker",
			message: 'search for an unmatched quote " in code',
		});
		expect(parseAgentsCommand('send "research helper" Keep all prior context.')).toEqual({
			action: "send",
			name: "research helper",
			message: "Keep all prior context.",
		});
		expect(parseAgentsCommand("stop --all")).toEqual({ action: "stop-all" });
		expect(() => parseAgentsCommand("spawn worker run task")).toThrow(/-- <task>/);
	});

	it("aggregates only model usage and sorts stats by descending cost with stable name ties", () => {
		const totals = aggregateUsage({
			models: { "provider/model": usage(11, 7, 0.125) },
			tools: { bash: usage(900, 900, 500) },
		} as never);
		expect(totals).toEqual({ input: 11, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 23, cost: 0.125 });
		expect(
			orderStatsRows([
				{ name: "beta", usage: { ...totals, cost: 1 } },
				{ name: "zeta", usage: { ...totals, cost: 0.5 } },
				{ name: "alpha", usage: { ...totals, cost: 1 } },
			]).map((row) => row.name),
		).toEqual(["alpha", "beta", "zeta"]);
	});
});
