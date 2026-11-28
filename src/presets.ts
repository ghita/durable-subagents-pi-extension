import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
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
	codemode?: boolean;
}

export interface PackagedAgentPreset {
	preset: AgentPreset;
	source: string;
}

export interface PresetInstallResult {
	installed: string[];
	skipped: string[];
}

export interface PresetCatalog {
	/** Named definitions and discovery errors, keyed by preset ID or relative file path. */
	entries: ReadonlyMap<string, { preset?: AgentPreset; error?: string; file?: string }>;
	valid: ReadonlyMap<string, AgentPreset>;
}

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SETTINGS_KEYS = new Set(["name", "description", "tools", "model", "effort", "thinking", "codemode"]);

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
	if (Object.hasOwn(settings, "model") && typeof settings.model !== "string") {
		throw new Error('"model" must be "inherit" or provider/model-id');
	}
	if (Object.hasOwn(settings, "effort") && Object.hasOwn(settings, "thinking")) {
		throw new Error('Use either "effort" or the Pi-native "thinking" field, not both');
	}
	const rawEffort = settings.effort ?? settings.thinking;
	if (typeof rawEffort !== "string") throw new Error('"effort" (or the Pi-native "thinking" alias) is required and must be "inherit" or a supported Pi thinking level');

	let tools: readonly DurableToolName[] | undefined;
	if (Object.hasOwn(settings, "tools")) tools = parseTools(settings.tools);
	if (Object.hasOwn(settings, "codemode") && typeof settings.codemode !== "boolean") {
		throw new Error('"codemode" must be a boolean');
	}

	let model: AgentPreset["model"];
	if (settings.model !== undefined && settings.model !== "inherit") model = parseModelReference(settings.model);

	let thinking: ModelThinkingLevel | undefined;
	if (rawEffort !== "inherit") {
		if (!THINKING_LEVELS.has(rawEffort as ModelThinkingLevel)) {
			throw new Error(`Unsupported effort level "${rawEffort}"`);
		}
		thinking = rawEffort as ModelThinkingLevel;
	}

	return {
		id: rawId,
		description: settings.description,
		instructions: body,
		...(tools === undefined ? {} : { tools }),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(settings.codemode === undefined ? {} : { codemode: settings.codemode as boolean }),
	};
}

function declaredPresetNames(document: ReturnType<typeof parseDocument>): string[] {
	const contents = document.contents;
	if (!isMap(contents)) return [];
	return contents.items.flatMap((pair) =>
		isScalar(pair.key) && pair.key.value === "name" && isScalar(pair.value)
			? [String(pair.value.value)]
			: [],
	);
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
	const definitions = new Map<string, Array<{ file: string; source?: string; error?: string }>>();
	for (const path of files) {
		const file = relative(directory, path).split(sep).join("/");
		let source: string;
		let errorNames: string[] = [];
		try {
			source = await readFile(path, "utf8");
			const lines = source.split(/\r?\n/);
			if (lines[0] !== "---") continue; // Supporting Markdown is intentionally ignored.
			const end = lines.findIndex((line, index) => index > 0 && line === "---");
			const yamlLines = end < 0 ? lines.slice(1) : lines.slice(1, end);
			const document = parseDocument(yamlLines.join("\n"), { uniqueKeys: true, version: "1.2", schema: "core" });
			// Preserve recoverable declared IDs even when YAML is malformed, so selecting
			// any affected preset fails closed instead of treating it as absent.
			errorNames = declaredPresetNames(document);
			if (end < 0) throw new Error("Unclosed YAML frontmatter; expected a closing --- line");
			if (document.errors.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.errors[0]?.message}`);
			if (document.warnings.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.warnings[0]?.message}`);
			const settings: unknown = document.toJS({ maxAliasCount: 0 });
			if (settings === null || typeof settings !== "object" || Array.isArray(settings)) continue; // No mapping means no `name` field.
			const rawName = (settings as Record<string, unknown>).name;
			if (rawName === undefined) continue;
			if (typeof rawName !== "string") {
				const invalidNameKey = String(rawName);
				const definitionsForName = definitions.get(invalidNameKey) ?? [];
				definitionsForName.push({ file, error: '"name" must be a preset ID string' });
				definitions.set(invalidNameKey, definitionsForName);
				continue;
			}
			if (!errorNames.includes(rawName)) errorNames.push(rawName);
			const definitionsForName = definitions.get(rawName) ?? [];
			definitionsForName.push({ file, source });
			definitions.set(rawName, definitionsForName);
		} catch (error) {
			// Key by every recoverable declared name, otherwise retain a path-keyed diagnostic.
			const message = error instanceof Error ? error.message : String(error);
			if (errorNames.length > 0) {
				for (const name of new Set(errorNames)) {
					const definitionsForName = definitions.get(name) ?? [];
					definitionsForName.push({ file, error: message });
					definitions.set(name, definitionsForName);
				}
			} else {
				entries.set(file, { error: message, file });
			}
		}
	}

	for (const [id, definitionsForName] of definitions) {
		if (definitionsForName.length > 1) {
			const filesForName = definitionsForName.map(({ file }) => file).join(", ");
			entries.set(id, { error: `Duplicate preset name "${id}" in: ${filesForName}`, file: filesForName });
			continue;
		}
		const definition = definitionsForName[0]!;
		if (definition.error !== undefined) {
			entries.set(id, { error: definition.error, file: definition.file });
			continue;
		}
		try {
			const preset = parseAgentPreset(definition.source!);
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

/** Packaged defaults live outside src so Pi installs include editable Markdown definitions verbatim. */
export const PACKAGED_PRESETS_DIRECTORY = fileURLToPath(new URL("../presets/", import.meta.url));

export async function loadPackagedPresets(directory = PACKAGED_PRESETS_DIRECTORY): Promise<PackagedAgentPreset[]> {
	const files = await markdownFiles(directory);
	const packaged: PackagedAgentPreset[] = [];
	for (const path of files) {
		const source = await readFile(path, "utf8");
		const preset = parseAgentPreset(source);
		packaged.push({ preset, source });
	}
	const ids = new Set<string>();
	for (const { preset } of packaged) {
		if (ids.has(preset.id)) throw new Error(`Packaged presets contain duplicate ID "${preset.id}".`);
		ids.add(preset.id);
	}
	return packaged.sort((a, b) => a.preset.id.localeCompare(b.preset.id));
}

/** Copy missing packaged IDs into <Pi agent dir>/agents without ever replacing user files. */
const PACKAGED_PRESET_DIRECTORY_NAME = "durable-subagents-pi-extension";

async function packagedPresetDirectory(agentsDirectory: string): Promise<string> {
	for (let suffix = 0; ; suffix += 1) {
		const name = suffix === 0 ? PACKAGED_PRESET_DIRECTORY_NAME : `${PACKAGED_PRESET_DIRECTORY_NAME}-${suffix}`;
		const directory = join(agentsDirectory, name);
		try {
			await mkdir(directory);
			return directory;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const existing = await lstat(directory);
				if (existing.isDirectory() && !existing.isSymbolicLink()) return directory;
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
			}
		}
	}
}

async function publishPackagedPreset(
	agentDir: string,
	installDirectory: string,
	preset: AgentPreset,
	source: string,
): Promise<"installed" | "already-installed"> {
	const temporaryFile = join(installDirectory, `.${preset.id}-${randomUUID()}.tmp`);
	let staged = false;
	try {
		// Write and close the complete source before atomically publishing its final .md link.
		const handle = await open(temporaryFile, "wx");
		staged = true;
		try { await handle.writeFile(source, { encoding: "utf8" }); }
		finally { await handle.close(); }
		for (let suffix = 0; ; suffix += 1) {
			const filename = suffix === 0 ? `${preset.id}.md` : `${preset.id}-${suffix}.md`;
			try {
				await link(temporaryFile, join(installDirectory, filename));
				return "installed";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new Error(`Unable to install packaged preset "${preset.id}": ${error instanceof Error ? error.message : String(error)}`);
				}
				// link() exposes only a fully written file, so a concurrent installer can safely
				// rescan frontmatter here rather than mistaking its publication for a filename clash.
				if ((await loadPresetCatalog(agentDir)).entries.has(preset.id)) return "already-installed";
			}
		}
	} finally {
		if (staged) {
			try { await unlink(temporaryFile); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}

export async function installPackagedPresets(
	agentDir: string,
	packagedPresets: readonly PackagedAgentPreset[],
): Promise<PresetInstallResult> {
	const agentsDirectory = join(agentDir, "agents");
	await mkdir(agentsDirectory, { recursive: true });
	const catalog = await loadPresetCatalog(agentDir);
	const knownIds = new Set(catalog.entries.keys());
	const installDirectory = await packagedPresetDirectory(agentsDirectory);
	const installed: string[] = [];
	const skipped: string[] = [];

	for (const { preset, source } of packagedPresets) {
		if (knownIds.has(preset.id)) {
			skipped.push(preset.id);
			continue;
		}
		const published = await publishPackagedPreset(agentDir, installDirectory, preset, source);
		if (published === "installed") installed.push(preset.id);
		else skipped.push(preset.id);
		knownIds.add(preset.id);
	}
	return { installed, skipped };
}
