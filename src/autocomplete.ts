const ACTIONS = ["help", "presets", "list", "status", "spawn", "send", "stop", "stats", "footer"] as const;

function items(values: readonly string[], partial: string, before: string) {
	const needle = partial.replace(/^['"]/, "").replace(/['"]$/, "").toLocaleLowerCase();
	const matching = values.filter((value) => value.toLocaleLowerCase().startsWith(needle));
	return matching.map((value) => ({
		// Pi replaces the entire argument prefix, not just the current token.
		value: before + (/\s|['"\\]/.test(value) ? JSON.stringify(value) : value),
		label: value,
	}));
}

/** Autocomplete the subcommand, cached presets and currently registered agent names. */
export function getAgentCompletions(prefix: string, presetIds: readonly string[], agentNames: readonly string[]) {
	// Keep quoted names together, including an unfinished quote while typing.
	const matches = [...prefix.matchAll(/"(?:\\.|[^"\\])*"?|'[^']*'?|\S+/g)];
	const last = matches.at(-1);
	const trailingSpace = last === undefined || last.index + last[0].length < prefix.length;
	const tokens = matches.map((match) => match[0]);
	const current = trailingSpace ? "" : (last?.[0] ?? "");
	const before = prefix.slice(0, trailingSpace ? prefix.length : last!.index);
	const complete = (values: readonly string[]) => items(values, current, before);
	if (tokens.length === 0) return complete(ACTIONS);

	const action = tokens[0];
	if (tokens.length === 1 && !trailingSpace) return complete(ACTIONS);

	if (action === "spawn") {
		const prior = trailingSpace ? tokens : tokens.slice(0, -1);
		if (prior.includes("--")) return null;
		if (prior.at(-1) === "--preset") return complete(presetIds);
		if (current.startsWith("--")) return complete(["--preset"]);
		if (prior.includes("--preset")) return null;
		return complete(presetIds);
	}

	if (action === "footer") {
		if ((trailingSpace && tokens.length === 1) || (!trailingSpace && tokens.length === 2)) {
			return complete(["alwaysOn", "activity"]);
		}
		return null;
	}

	if (action === "status" || action === "send" || action === "stop") {
		if (action === "stop" && (current === "--all" || (trailingSpace && tokens.includes("--all")))) return null;
		if ((trailingSpace && tokens.length === 1) || (!trailingSpace && tokens.length === 2)) return complete(agentNames);
		return null;
	}

	return null;
}
