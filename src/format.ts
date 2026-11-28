import type { AgentSummary, StatsRow, UsageTotals } from "./agent-service.ts";
import type { PackagedAgentPreset, PresetCatalog } from "./presets.ts";

function money(value: number): string {
	return `$${value.toFixed(6)}`;
}

function tokenLine(usage: UsageTotals): string {
	return `in ${usage.input.toLocaleString()}, out ${usage.output.toLocaleString()}, cache read ${usage.cacheRead.toLocaleString()}, cache write ${usage.cacheWrite.toLocaleString()}`;
}

export function formatAgentSummary(agent: AgentSummary): string {
	const state = agent.active ? "active" : "idle";
	const preset = agent.presetId === null ? "unconfigured" : `preset ${agent.presetId}`;
	return `${agent.name} — ${state}; ${preset}; cost ${money(agent.usage.cost)}; ${tokenLine(agent.usage)}; messages in/out ${agent.incomingCount}/${agent.outgoingCount}`;
}

export function formatAgentList(agents: readonly AgentSummary[]): string {
	return agents.length === 0 ? "No managed agents are registered." : agents.map(formatAgentSummary).join("\n");
}

export function formatStats(total: UsageTotals, rows: readonly StatsRow[]): string {
	const header = `Managed-agent total: cost ${money(total.cost)}; ${tokenLine(total)} (provider-reported and catalog-estimated costs may be mixed).`;
	if (rows.length === 0) return `${header}\nNo managed-agent usage recorded.`;
	return [header, ...rows.map(({ name, usage }) => `${name} — ${money(usage.cost)}; ${tokenLine(usage)}`)].join("\n");
}

export function describePresetsForAgent(catalog: PresetCatalog): string {
	const presets = [...catalog.valid.values()].sort((a, b) => a.id.localeCompare(b.id));
	return presets.length === 0
		? "No configured presets are currently cached."
		: `Cached presets (ID — purpose; available tools): ${presets.map((preset) => `${preset.id} — ${preset.description}; ${preset.tools?.join(", ") ?? "all durable tools"}`).join(" | ")}.`;
}

export function formatPresets(catalog: PresetCatalog, packagedPresets: readonly PackagedAgentPreset[] = []): string {
	const installed = [...catalog.entries.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, entry]) => {
			if (entry.error !== undefined) return `${id} — INVALID: ${entry.error}${entry.file === undefined ? "" : ` (${entry.file})`}`;
			const preset = entry.preset!;
			const tools = preset.tools === undefined ? "all durable tools" : `tools: ${preset.tools.join(", ")}`;
			return `${id} — ${preset.description} (${tools})`;
		});
	const missing = packagedPresets.filter(({ preset }) => !catalog.entries.has(preset.id));
	if (installed.length === 0) installed.push("No presets found. Add user-global agent definitions under <Pi agent dir>/agents/**/*.md.");
	if (missing.length > 0) {
		installed.push(`Packaged defaults missing: ${missing.map(({ preset }) => preset.id).join(", ")}. Run /agents install to add them.`);
	}
	return installed.join("\n");
}

export function formatHelp(presets: PresetCatalog): string {
	const ids = [...presets.valid.keys()].sort((a, b) => a.localeCompare(b));
	return [
		"/agents help | presets | install | list | status <name> | spawn <name> [--preset <id>] -- <task>",
		"/agents send <name> <message> | stop <name> | stop --all | stats",
		"/agents footer alwaysOn|activity",
		`Cached presets: ${ids.length === 0 ? "(none)" : ids.join(", ")}`,
		"Unconfigured agents receive read/write/edit/bash. Read-only behavior is only a prompt instruction, not a security boundary.",
		"Durable agents require a persisted Pi session and use Pi's model registry and configured provider authentication.",
	].join("\n");
}
