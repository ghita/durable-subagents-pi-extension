import { describe, expect, it } from "vitest";
import { getAgentCompletions } from "../src/autocomplete.ts";

describe("/agents completions", () => {
	const presets = ["researcher", "writer"];
	const agents = ["researcher", "file reviewer"];

	it("suggests actions, presets after spawn and after --preset, and agent names", () => {
		expect(getAgentCompletions("", presets, agents)?.map((item) => item.value)).toContain("spawn");
		expect(getAgentCompletions("spawn ", presets, agents)?.map((item) => item.value)).toEqual(presets);
		expect(getAgentCompletions("spawn --preset ", presets, agents)?.map((item) => item.value)).toEqual(presets);
		expect(getAgentCompletions("status ", presets, agents)?.map((item) => item.value)).toEqual(["researcher", '"file reviewer"']);
		expect(getAgentCompletions("stop --all", presets, agents)).toBeNull();
	});
});
