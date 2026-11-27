import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describePresetsForAgent, formatPresets } from "../src/format.ts";
import { getPresetOrFallback, loadPresetCatalog, parseAgentPreset } from "../src/presets.ts";

const tempDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "durable-subagent-presets-"));
	tempDirectories.push(directory);
	return directory;
}

const validDefinition = (name = "researcher", extra = "") =>
	`---\nname: ${name}\ndescription: Research a topic and return a concise report.\nmodel: inherit\neffort: inherit\n${extra}---\n\nBe concise and cite sources.\n`;

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agent presets", () => {
	it("parses the required Claude-style metadata and preserves the Markdown body", () => {
		const preset = parseAgentPreset(
			"---\nname: researcher\ndescription: Find and summarize reliable sources.\ntools: [read, bash]\nmodel: test-provider/test-model\neffort: high\n---\n\nBe concise and cite sources.\n",
		);

		expect(preset).toEqual({
			id: "researcher",
			description: "Find and summarize reliable sources.",
			tools: ["read", "bash"],
			model: { provider: "test-provider", modelId: "test-model" },
			thinking: "high",
			instructions: "Be concise and cite sources.",
		});
	});

	it("represents inherited model and effort settings as live inheritance", () => {
		const preset = parseAgentPreset(validDefinition());
		expect(preset.model).toBeUndefined();
		expect(preset.thinking).toBeUndefined();
	});

	it("shows descriptions and effective tool availability in user and parent-agent listings", () => {
		const preset = parseAgentPreset(validDefinition("researcher", "tools: [read, bash]\n"));
		const catalog = { entries: new Map([[preset.id, { preset }]]), valid: new Map([[preset.id, preset]]) };

		expect(formatPresets(catalog)).toContain("researcher — Research a topic and return a concise report. (tools: read, bash)");
		expect(describePresetsForAgent(catalog)).toContain("researcher — Research a topic and return a concise report.; read, bash");
	});

	it("recursively discovers named Markdown definitions and ignores supporting Markdown", async () => {
		const agentDir = await temporaryDirectory();
		const agentsDir = join(agentDir, "agents");
		await mkdir(join(agentsDir, "research", "nested"), { recursive: true });
		await writeFile(join(agentsDir, "research", "nested", "researcher.md"), validDefinition("deep-researcher"), "utf8");
		await writeFile(join(agentsDir, "research", "sources.md"), "# Sources\nNo agent metadata here.\n", "utf8");
		const catalog = await loadPresetCatalog(agentDir);

		expect([...catalog.valid.keys()]).toEqual(["deep-researcher"]);
		expect(catalog.entries.size).toBe(1);
		expect(catalog.valid.get("deep-researcher")?.description).toContain("Research a topic");
	});

	it("treats a missing preset as generic but fails closed for an invalid named preset", async () => {
		const agentDir = await temporaryDirectory();
		const file = join(agentDir, "agents", "nested", "broken.md");
		await mkdir(join(agentDir, "agents", "nested"), { recursive: true });
		await writeFile(file, validDefinition("broken", "tools: [read, root]\n"), "utf8");
		const catalog = await loadPresetCatalog(agentDir);

		expect(getPresetOrFallback(catalog, "not-installed")).toBeUndefined();
		expect(() => getPresetOrFallback(catalog, "broken")).toThrow(/Unsupported durable tool/);
		expect(catalog.valid.has("broken")).toBe(false);
	});

	it("rejects all colliding definitions instead of depending on traversal order", async () => {
		const agentDir = await temporaryDirectory();
		await mkdir(join(agentDir, "agents", "a"), { recursive: true });
		await mkdir(join(agentDir, "agents", "z"), { recursive: true });
		await writeFile(join(agentDir, "agents", "a", "one.md"), validDefinition("same"), "utf8");
		await writeFile(join(agentDir, "agents", "z", "two.md"), validDefinition("same"), "utf8");
		const catalog = await loadPresetCatalog(agentDir);

		expect(catalog.valid.has("same")).toBe(false);
		expect(catalog.entries.get("same")?.error).toMatch(/a\/one.md, z\/two.md/);
		expect(() => getPresetOrFallback(catalog, "same")).toThrow(/Duplicate preset name/);
	});

	it.each([
		["unknown key", validDefinition("writer", "foo: bar\n")],
		["duplicate key", validDefinition("writer", "tools: [read]\ntools: [bash]\n")],
		["duplicate tool", validDefinition("writer", "tools: [read, read]\n")],
		["empty tool allowlist", validDefinition("writer", "tools: []\n")],
		["invalid model reference", validDefinition("writer").replace("model: inherit", "model: invalid")],
		["whitespace in model reference", validDefinition("writer").replace("model: inherit", "model: provider/ model")],
		["invalid effort", validDefinition("writer").replace("effort: inherit", "effort: limitless")],
		["missing required description", validDefinition("writer").replace("description: Research a topic and return a concise report.\n", "")],
		["invalid name", validDefinition("bad name")],
		["empty prompt", validDefinition("writer").replace("Be concise and cite sources.\n", "  \n")],
	])("rejects %s", (_label, markdown) => {
		expect(() => parseAgentPreset(markdown)).toThrow();
	});

	it("retains malformed frontmatter diagnostics and ignores valid files without a name", async () => {
		const agentDir = await temporaryDirectory();
		const agentsDir = join(agentDir, "agents");
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(agentsDir, "broken.md"), "---\nname: broken\ndescription: [unterminated\n---\nInstructions", "utf8");
		await writeFile(join(agentsDir, "unidentifiable.md"), "---\nname: [\n---\nInstructions", "utf8");
		await writeFile(join(agentsDir, "unclosed.md"), "---\nname: unclosed\ndescription: Missing closing delimiter\nmodel: inherit\neffort: high\n\nInstructions", "utf8");
		await writeFile(join(agentsDir, "non-string-id.md"), "---\nname: 123\ndescription: Numeric name\nmodel: inherit\neffort: high\n---\nInstructions", "utf8");
		await writeFile(join(agentsDir, "invalid-id.md"), validDefinition("bad name"), "utf8");
		await writeFile(join(agentsDir, "collision-malformed.md"), "---\nname: collision\ndescription: [unterminated\n---\nInstructions", "utf8");
		await writeFile(join(agentsDir, "collision-valid.md"), validDefinition("collision"), "utf8");
		await writeFile(join(agentsDir, "notes.md"), "---\ntitle: Notes\n---\nSupporting doc", "utf8");
		await writeFile(join(agentsDir, "scalar.md"), "---\njust a supporting note\n---\nBody", "utf8");
		await writeFile(join(agentsDir, "list.md"), "---\n- supporting\n- material\n---\nBody", "utf8");
		const catalog = await loadPresetCatalog(agentDir);

		expect(catalog.entries.get("broken")?.error).toMatch(/Invalid YAML frontmatter/);
		expect(() => getPresetOrFallback(catalog, "broken")).toThrow(/Preset "broken" is invalid/);
		expect(catalog.entries.get("unidentifiable.md")?.error).toMatch(/Invalid YAML frontmatter/);
		expect(catalog.entries.get("unclosed")?.error).toMatch(/Unclosed YAML frontmatter/);
		expect(() => getPresetOrFallback(catalog, "unclosed")).toThrow(/Preset "unclosed" is invalid/);
		expect(catalog.entries.get("123")?.error).toMatch(/preset ID string/);
		expect(() => getPresetOrFallback(catalog, "123")).toThrow(/Preset "123" is invalid/);
		expect(catalog.entries.get("bad name")?.error).toMatch(/preset ID/);
		expect(() => getPresetOrFallback(catalog, "bad name")).toThrow(/Preset "bad name" is invalid/);
		expect(catalog.entries.get("collision")?.error).toMatch(/collision-malformed.md, collision-valid.md/);
		expect(() => getPresetOrFallback(catalog, "collision")).toThrow(/Duplicate preset name/);
		expect(catalog.entries.has("notes.md")).toBe(false);
		expect(catalog.entries.has("scalar.md")).toBe(false);
		expect(catalog.entries.has("list.md")).toBe(false);
		expect(catalog.valid.size).toBe(0);
	});

	it("treats an absent agents directory as an empty catalog", async () => {
		const catalog = await loadPresetCatalog(await temporaryDirectory());
		expect(catalog.entries.size).toBe(0);
		expect(catalog.valid.size).toBe(0);
	});
});
