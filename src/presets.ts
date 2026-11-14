import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const DURABLE_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export type DurableToolName = (typeof DURABLE_TOOL_NAMES)[number];

export interface AgentPreset {
	id: string;
	instructions: string;
	tools?: readonly DurableToolName[];
	model?: { provider: string; modelId: string };
	thinking?: ModelThinkingLevel;
}

export interface PresetCatalog {
	/** Every on-disk preset directory, including malformed ones, for fail-closed lookup. */
	entries: ReadonlyMap<string, { preset?: AgentPreset; error?: string }>;
	valid: ReadonlyMap<string, AgentPreset>;
}

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SETTINGS_KEYS = new Set(["tools", "model", "thinking"]);

export function isValidPresetId(id: string): boolean {
	return PRESET_ID.test(id);
}

function parseModelReference(value: unknown): AgentPreset["model"] {
	if (typeof value !== "string" || value.trim() !== value || /\s/.test(value)) {
		throw new Error('"model" must be a provider/model-id string without whitespace');
	}
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error('"model" must have the form provider/model-id');
	}
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function parseTools(value: unknown): readonly DurableToolName[] {
	if (!Array.isArray(value) || !value.every((tool) => typeof tool === "string")) {
		throw new Error('"tools" must be an array of durable-native tool names');
	}
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

function parseFrontmatter(markdown: string): { settings: Record<string, unknown>; body: string } {
	const lines = markdown.split(/\r?\n/);
	if (lines[0] !== "---") return { settings: {}, body: markdown.trim() };
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
	const settings = value as Record<string, unknown>;
	for (const key of Object.keys(settings)) {
		if (!SETTINGS_KEYS.has(key)) throw new Error(`Unknown preset setting "${key}"`);
	}
	return { settings, body: lines.slice(closingLine + 1).join("\n").trim() };
}

export function parseAgentPreset(id: string, markdown: string): AgentPreset {
	if (!isValidPresetId(id)) throw new Error(`Invalid preset ID "${id}"`);
	const { settings, body } = parseFrontmatter(markdown);
	if (body.length === 0) throw new Error("Preset instruction body must not be empty");

	let tools: readonly DurableToolName[] | undefined;
	if (Object.hasOwn(settings, "tools")) tools = parseTools(settings.tools);

	let model: AgentPreset["model"];
	if (Object.hasOwn(settings, "model")) model = parseModelReference(settings.model);

	let thinking: ModelThinkingLevel | undefined;
	if (Object.hasOwn(settings, "thinking")) {
		if (typeof settings.thinking !== "string" || !THINKING_LEVELS.has(settings.thinking as ModelThinkingLevel)) {
			throw new Error(`Unsupported thinking level "${String(settings.thinking)}"`);
		}
		thinking = settings.thinking as ModelThinkingLevel;
	}

	return {
		id,
		instructions: body,
		...(tools === undefined ? {} : { tools }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
	};
}

/** Read user-global presets once per extension load; call again only after Pi reload. */
export async function loadPresetCatalog(agentDir: string): Promise<PresetCatalog> {
	const directory = join(agentDir, "agents");
	let children;
	try {
		children = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { entries: new Map(), valid: new Map() };
		}
		throw new Error(`Unable to read preset directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const entries = new Map<string, { preset?: AgentPreset; error?: string }>();
	for (const child of children) {
		if (!child.isDirectory()) continue;
		const id = child.name;
		try {
			if (!isValidPresetId(id)) throw new Error(`Invalid preset ID "${id}"`);
			const source = await readFile(join(directory, id, "agent.md"), "utf8");
			entries.set(id, { preset: parseAgentPreset(id, source) });
		} catch (error) {
			entries.set(id, { error: error instanceof Error ? error.message : String(error) });
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
