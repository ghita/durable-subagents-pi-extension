import { describe, expect, it } from "vitest";
import { parseAgentsCommand } from "../src/command-parser.ts";

describe("/agents command parsing", () => {
	it("accepts install without arguments", () => {
		expect(parseAgentsCommand("install")).toEqual({ action: "install" });
		expect(() => parseAgentsCommand("install now")).toThrow(/Unexpected arguments/);
	});

	it("reports or sets a nonnegative safe integer budget", () => {
		expect(parseAgentsCommand("panes")).toEqual({ action: "panes" });
		for (const limit of [0, 3, 100, Number.MAX_SAFE_INTEGER]) {
			expect(parseAgentsCommand(` panes ${limit} `)).toEqual({ action: "panes", limit });
		}
	});

	it.each(["-1", "+1", "1.5", "NaN", "Infinity", "1e2", "0x10", "9007199254740992", "1 2", '""'])
	("rejects invalid budget %s", (argument) => {
		expect(() => parseAgentsCommand(`panes ${argument}`)).toThrow(/nonnegative safe integer/);
	});
});
