import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPresetOrFallback, loadPresetCatalog, parseAgentPreset } from "../src/presets.ts";

const tempDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "durable-subagent-presets-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agent presets", () => {
	it("parses optional settings and preserves the Markdown instruction body", () => {
		const preset = parseAgentPreset(
			"researcher",
			"---\ntools: [read, bash]\nmodel: github-copilot/gpt-6-luna\nthinking: high\n---\n\nBe concise and cite sources.\n",
		);

		expect(preset).toEqual({
			id: "researcher",
			tools: ["read", "bash"],
			model: { provider: "github-copilot", modelId: "gpt-6-luna" },
			thinking: "high",
			instructions: "Be concise and cite sources.",
		});
	});

	it("treats a missing preset as generic but fails closed for a malformed present preset", async () => {
		const agentDir = await temporaryDirectory();
		const agentsDir = join(agentDir, "agents");
		await mkdir(join(agentsDir, "broken"), { recursive: true });
		await writeFile(join(agentsDir, "broken", "agent.md"), "---\ntools: [read, root]\n---\nDo work.\n", "utf8");
		const catalog = await loadPresetCatalog(agentDir);

		expect(getPresetOrFallback(catalog, "not-installed")).toBeUndefined();
		expect(() => getPresetOrFallback(catalog, "broken")).toThrow(/Unsupported durable tool/);
		expect(catalog.valid.has("broken")).toBe(false);
	});

	it.each([
		["unknown key", "---\nfoo: bar\n---\nInstructions"],
		["duplicate key", "---\ntools: [read]\ntools: [bash]\n---\nInstructions"],
		["duplicate tool", "---\ntools: [read, read]\n---\nInstructions"],
		["invalid model reference", "---\nmodel: invalid\n---\nInstructions"],
		["invalid thinking", "---\nthinking: limitless\n---\nInstructions"],
		["empty prompt", "---\ntools: [read]\n---\n  \n"],
	])("rejects %s", (_label, markdown) => {
		expect(() => parseAgentPreset("writer", markdown)).toThrow();
	});

	it("treats an absent agents directory as an empty catalog", async () => {
		const catalog = await loadPresetCatalog(await temporaryDirectory());
		expect(catalog.entries.size).toBe(0);
		expect(catalog.valid.size).toBe(0);
	});
});
