import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getAgentCompletions } from "../src/autocomplete.ts";
import { parseAgentsCommand } from "../src/command-parser.ts";

describe("/agents completions", () => {
	const presets = ["researcher", "writer"];
	const agents = ["scout", "researcher", "file reviewer"];

	it("suggests actions and full argument replacements for presets and agents", () => {
		expect(getAgentCompletions("", presets, agents)?.map((item) => item.value)).toContain("spawn");
		expect(getAgentCompletions("in", presets, agents)).toEqual([{ value: "install", label: "install" }]);
		expect(getAgentCompletions("spawn ", presets, agents)?.map((item) => item.value)).toEqual(["spawn researcher", "spawn writer"]);
		expect(getAgentCompletions("spawn --preset ", presets, agents)?.map((item) => item.value)).toEqual(["spawn --preset researcher", "spawn --preset writer"]);
		expect(getAgentCompletions("status ", presets, agents)?.map((item) => item.value)).toEqual(["status scout", "status researcher", 'status "file reviewer"']);
		expect(getAgentCompletions("footer ", presets, agents)?.map((item) => item.value)).toEqual(["footer alwaysOn", "footer activity"]);
		expect(getAgentCompletions("footer al", presets, agents)).toEqual([{ value: "footer alwaysOn", label: "alwaysOn" }]);
		expect(getAgentCompletions("stop --all", presets, agents)).toBeNull();
	});

	it.each(["status", "send", "stop"])("keeps %s when Pi applies an agent-name completion", async (action) => {
		const provider = new CombinedAutocompleteProvider([
			{ name: "agents", getArgumentCompletions: (prefix) => getAgentCompletions(prefix, presets, agents) },
		], process.cwd());
		const line = `/agents ${action} sc`;
		const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		expect(suggestions?.items).toEqual([{ value: `${action} scout`, label: "scout" }]);
		const completed = provider.applyCompletion([line], 0, line.length, suggestions!.items[0]!, suggestions!.prefix);
		expect(completed.lines).toEqual([`/agents ${action} scout`]);
		expect(completed.cursorCol).toBe(completed.lines[0]!.length);
		const args = completed.lines[0]!.slice("/agents ".length);
		expect(parseAgentsCommand(action === "send" ? `${args} Continue searching` : args)).toMatchObject({ action, name: "scout" });
	});

	it("preserves spawn options, instance names, and whitespace", () => {
		expect(getAgentCompletions("spawn audit --preset wr", presets, agents)).toEqual([{ value: "spawn audit --preset writer", label: "writer" }]);
		expect(getAgentCompletions('spawn "file reviewer" --pre', presets, agents)).toEqual([{ value: 'spawn "file reviewer" --preset', label: "--preset" }]);
		expect(getAgentCompletions("status   sc", presets, agents)).toEqual([{ value: "status   scout", label: "scout" }]);
	});

	it("completes quoted names without duplicating or dropping quotes", () => {
		for (const prefix of ['status "file rev', 'status "file reviewer"', "status 'file rev"]) {
			const result = getAgentCompletions(prefix, presets, agents);
			expect(result).toEqual([{ value: 'status "file reviewer"', label: "file reviewer" }]);
			expect(parseAgentsCommand(result![0]!.value)).toEqual({ action: "status", name: "file reviewer" });
		}
	});

	it("does not replace messages, tasks, or already-completed names", () => {
		for (const prefix of ["send scout ", 'send "file reviewer" Continue', "status scout ", "spawn -- research", "spawn --preset researcher -- wr", "spawn audit --preset researcher "]) {
			expect(getAgentCompletions(prefix, presets, agents)).toBeNull();
		}
	});
});
