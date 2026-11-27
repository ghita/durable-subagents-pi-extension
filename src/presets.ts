import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const DURABLE_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export type DurableToolName = (typeof DURABLE_TOOL_NAMES)[number];

export interface AgentPreset {
	id: string;
	description: string;
	instructions: string;
	tools?: readonly DurableToolName[];
	model?: { provider: string; modelId: string };
	thinking?: ModelThinkingLevel;
}

export interface PresetCatalog {
	/** Named definitions and discovery errors, keyed by preset ID or relative file path. */
	entries: ReadonlyMap<string, { preset?: AgentPreset; error?: string; file?: string }>;
	valid: ReadonlyMap<string, AgentPreset>;
}

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SETTINGS_KEYS = new Set(["name", "description", "tools", "model", "effort"]);

export function isValidPresetId(id: string): boolean {
	return PRESET_ID.test(id);
}

function parseModelReference(value: unknown): AgentPreset["model"] {
	if (typeof value !== "string" || value.trim() !== value || /\s/.test(value)) {
		throw new Error('"model" must be "inherit" or a provider/model-id string without whitespace');
	}
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error('"model" must be "inherit" or have the form provider/model-id');
	}
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function parseTools(value: unknown): readonly DurableToolName[] {
	if (!Array.isArray(value) || !value.every((tool) => typeof tool === "string")) {
		throw new Error('"tools" must be an array of durable-native tool names');
	}
	if (value.length === 0) throw new Error('"tools" must not be empty');
	const seen = new Set<string>();
	for (const tool of value as string[]) {
		if (!(DURABLE_TOOL_NAMES as readonly string[]).includes(tool)) {
			throw new Error(`Unsupported durable tool "${tool}". Allowed tools: ${DURABLE_TOOL_NAMES.join(", ")}`);
		}
		if (seen.has(tool)) throw new Error(`Duplicate tool "${tool}" in preset`);
		seen.add(tool);
	}
	return value as DurableToolName[];
}

type ParsedDocument = { settings: Record<string, unknown>; body: string };

function parseFrontmatter(markdown: string): ParsedDocument {
	const lines = markdown.split(/\r?\n/);
	if (lines[0] !== "---") throw new Error("Agent definition must begin with YAML frontmatter (---)");
	const closingLine = lines.findIndex((line, index) => index > 0 && line === "---");
	if (closingLine < 0) throw new Error("Unclosed YAML frontmatter; expected a closing --- line");
	const source = lines.slice(1, closingLine).join("\n");
	const document = parseDocument(source, { uniqueKeys: true, version: "1.2", schema: "core" });
	if (document.errors.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.errors[0]?.message}`);
	if (document.warnings.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.warnings[0]?.message}`);
	const value: unknown = document.toJS({ maxAliasCount: 0 });
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("YAML frontmatter must be a mapping");
	}
	return { settings: value as Record<string, unknown>, body: lines.slice(closingLine + 1).join("\n").trim() };
}

/** Parse one complete named agent Markdown definition. */
export function parseAgentPreset(markdown: string): AgentPreset {
	const { settings, body } = parseFrontmatter(markdown);
	for (const key of Object.keys(settings)) {
		if (!SETTINGS_KEYS.has(key)) throw new Error(`Unknown preset setting "${key}"`);
	}

	const rawId = settings.name;
	if (typeof rawId !== "string" || rawId.trim() !== rawId || !isValidPresetId(rawId)) {
		throw new Error('"name" must be a preset ID: 1–64 ASCII letters, numbers, "_", or "-", beginning with a letter or number');
	}
	if (typeof settings.description !== "string" || settings.description.trim() === "") {
		throw new Error('"description" is required and must be a non-empty string');
	}
	if (body.length === 0) throw new Error("Preset instruction body must not be empty");
	if (typeof settings.model !== "string") throw new Error('"model" is required and must be "inherit" or provider/model-id');
	if (typeof settings.effort !== "string") throw new Error('"effort" is required and must be "inherit" or a supported Pi thinking level');

	let tools: readonly DurableToolName[] | undefined;
	if (Object.hasOwn(settings, "tools")) tools = parseTools(settings.tools);

	let model: AgentPreset["model"];
	if (settings.model !== "inherit") model = parseModelReference(settings.model);

	let thinking: ModelThinkingLevel | undefined;
	if (settings.effort !== "inherit") {
		if (!THINKING_LEVELS.has(settings.effort as ModelThinkingLevel)) {
			throw new Error(`Unsupported effort level "${settings.effort}"`);
		}
		thinking = settings.effort as ModelThinkingLevel;
	}

	return {
		id: rawId,
		description: settings.description,
		instructions: body,
		...(tools === undefined ? {} : { tools }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
	};
}

async function markdownFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	const visit = async (current: string): Promise<void> => {
		const children = await readdir(current, { withFileTypes: true });
		children.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			const path = join(current, child.name);
			if (child.isDirectory()) await visit(path);
			else if (child.isFile() && child.name.endsWith(".md")) result.push(path);
		}
	};
	await visit(directory);
	return result;
}

/** Read user-global presets once per extension load; call again only after Pi reload. */
export async function loadPresetCatalog(agentDir: string): Promise<PresetCatalog> {
	const directory = join(agentDir, "agents");
	let files: string[];
	try {
		files = await markdownFiles(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: new Map(), valid: new Map() };
		throw new Error(`Unable to read preset directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const entries = new Map<string, { preset?: AgentPreset; error?: string; file?: string }>();
	const definitions = new Map<string, Array<{ file: string; source: string }>>();
	for (const path of files) {
		const file = relative(directory, path).split(sep).join("/");
		let source: string;
		try {
			source = await readFile(path, "utf8");
			const lines = source.split(/\r?\n/);
			if (lines[0] !== "---") continue; // Supporting Markdown is intentionally ignored.
			const end = lines.findIndex((line, index) => index > 0 && line === "---");
			if (end < 0) throw new Error("Unclosed YAML frontmatter; expected a closing --- line");
			const document = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true, version: "1.2", schema: "core" });
			if (document.errors.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.errors[0]?.message}`);
			if (document.warnings.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.warnings[0]?.message}`);
			const settings: unknown = document.toJS({ maxAliasCount: 0 });
			if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
				entries.set(file, { error: "YAML frontmatter must be a mapping", file });
				continue;
			}
			const rawName = (settings as Record<string, unknown>).name;
			if (rawName === undefined) continue;
			if (typeof rawName !== "string" || rawName.trim() !== rawName || rawName.length === 0) {
				entries.set(file, { error: '"name" must be a non-empty preset ID string', file });
				continue;
			}
			const definitionsForName = definitions.get(rawName) ?? [];
			definitionsForName.push({ file, source });
			definitions.set(rawName, definitionsForName);
		} catch (error) {
			// YAML errors cannot be reliably associated with a preset ID, so retain
			// a path-keyed diagnostic instead of silently hiding a malformed file.
			entries.set(file, { error: error instanceof Error ? error.message : String(error), file });
		}
	}

	for (const [id, definitionsForName] of definitions) {
		if (definitionsForName.length > 1) {
			const filesForName = definitionsForName.map(({ file }) => file).join(", ");
			entries.set(id, { error: `Duplicate preset name "${id}" in: ${filesForName}`, file: filesForName });
			continue;
		}
		const definition = definitionsForName[0]!;
		try {
			const preset = parseAgentPreset(definition.source);
			entries.set(id, { preset, file: definition.file });
		} catch (error) {
			entries.set(id, { error: error instanceof Error ? error.message : String(error), file: definition.file });
		}
	}
	const valid = new Map<string, AgentPreset>();
	for (const [id, entry] of entries) if (entry.preset !== undefined) valid.set(id, entry.preset);
	return { entries, valid };
}

/** A missing preset is the generic all-tools case; an existing invalid one fails closed. */
export function getPresetOrFallback(catalog: PresetCatalog, id: string | undefined): AgentPreset | undefined {
	if (id === undefined) return undefined;
	const entry = catalog.entries.get(id);
	if (entry?.error !== undefined) throw new Error(`Preset "${id}" is invalid: ${entry.error}`);
	return entry?.preset;
}
