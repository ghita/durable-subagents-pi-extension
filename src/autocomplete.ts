const ACTIONS = ["help", "presets", "list", "status", "spawn", "send", "stop", "stats"] as const;

function items(values: readonly string[], partial: string) {
	const needle = partial.replace(/^['"]/, "").toLocaleLowerCase();
	const matching = values.filter((value) => value.toLocaleLowerCase().startsWith(needle));
	return matching.map((value) => ({
		value: /\s/.test(value) ? JSON.stringify(value) : value,
		label: value,
	}));
}

/** Autocomplete the subcommand, cached presets and currently registered agent names. */
export function getAgentCompletions(prefix: string, presetIds: readonly string[], agentNames: readonly string[]) {
	const trailingSpace = /\s$/.test(prefix);
	const tokens = prefix.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return items(ACTIONS, "");

	const action = tokens[0];
	const current = trailingSpace ? "" : (tokens.at(-1) ?? "");
	if (tokens.length === 1 && !trailingSpace) return items(ACTIONS, current);

	if (action === "spawn") {
		const prior = trailingSpace ? tokens : tokens.slice(0, -1);
		if (prior.includes("--preset")) return items(presetIds, current);
		if (current === "--preset") return items(["--preset"], current);
		if (current.startsWith("--")) return items(["--preset"], current);
		if (prior.includes("--")) return null;
		return items(presetIds, current);
	}

	if (action === "status" || action === "send" || action === "stop") {
		if (action === "stop" && (current === "--all" || (trailingSpace && tokens.includes("--all")))) return null;
		if ((trailingSpace && tokens.length === 1) || tokens.length === 2) return items(agentNames, current);
		return null;
	}

	return null;
}
