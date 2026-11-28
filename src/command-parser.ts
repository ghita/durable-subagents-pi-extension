export type AgentsCommand =
	| { action: "help" | "presets" | "list" | "stats" | "install" }
	| { action: "footer"; alwaysOn: boolean }
	| { action: "panes"; limit?: number }
	| { action: "status"; name: string }
	| { action: "send"; name: string; message: string }
	| { action: "stop"; name: string }
	| { action: "stop-all" }
	| { action: "spawn"; name?: string; presetId?: string; message: string };

type Word = { value: string; start: number; end: number };

function words(source: string): Word[] {
	const result: Word[] = [];
	let index = 0;
	while (index < source.length) {
		while (/\s/.test(source[index] ?? "")) index += 1;
		if (index >= source.length) break;
		const start = index;
		let value = "";
		let quote: "'" | '"' | undefined;
		while (index < source.length) {
			const char = source[index]!;
			if (quote === undefined && /\s/.test(char)) break;
			if (char === "\\" && index + 1 < source.length) {
				value += source[index + 1];
				index += 2;
				continue;
			}
			if (quote !== undefined) {
				if (char === quote) quote = undefined;
				else value += char;
				index += 1;
				continue;
			}
			if (char === "'" || char === '"') {
				quote = char;
				index += 1;
				continue;
			}
			value += char;
			index += 1;
		}
		if (quote !== undefined) throw new Error("Unclosed quote in /agents arguments.");
		result.push({ value, start, end: index });
	}
	return result;
}

function spawnDelimiter(source: string): number {
	let index = 0;
	while (index < source.length) {
		while (/\s/.test(source[index] ?? "")) index += 1;
		if (index >= source.length) break;
		const start = index;
		let quote: "'" | '"' | undefined;
		while (index < source.length) {
			const char = source[index]!;
			if (quote === undefined && /\s/.test(char)) break;
			if (char === "\\" && index + 1 < source.length) {
				index += 2;
				continue;
			}
			if (quote !== undefined) {
				if (char === quote) quote = undefined;
				index += 1;
				continue;
			}
			if (char === "'" || char === '"') quote = char;
			index += 1;
		}
		if (quote !== undefined) throw new Error("Unclosed quote in /agents arguments before --.");
		if (source.slice(start, index) === "--") return start;
	}
	return -1;
}

function parseSpawnCommand(input: string): AgentsCommand {
	const delimiterAt = spawnDelimiter(input);
	if (delimiterAt < 0) throw new Error("Usage: /agents spawn <name> [--preset <preset-id>] -- <task>");
	const head = words(input.slice(0, delimiterAt));
	const task = input.slice(delimiterAt + 2).trim();
	if (task === "") throw new Error("Spawn needs a task after --.");
	let name: string | undefined;
	let presetId: string | undefined;
	for (let index = 1; index < head.length; index += 1) {
		const value = head[index]!.value;
		if (value === "--preset") {
			if (presetId !== undefined || head[index + 1] === undefined || head[index + 1]!.value.startsWith("--")) {
				throw new Error("--preset needs one preset ID and may be used only once.");
			}
			presetId = head[index + 1]!.value;
			index += 1;
		} else if (value.startsWith("--")) {
			throw new Error(`Unknown spawn option "${value}".`);
		} else if (name === undefined) {
			name = value;
		} else {
			throw new Error("Spawn accepts one instance name before --; quote names containing spaces.");
		}
	}
	return { action: "spawn", ...(name === undefined ? {} : { name }), ...(presetId === undefined ? {} : { presetId }), message: task };
}

export function parseAgentsCommand(source: string): AgentsCommand {
	const input = source.trim();
	if (input === "") return { action: "help" };
	const firstToken = input.match(/^\S+/)?.[0] ?? "";
	if (firstToken === "spawn") return parseSpawnCommand(input);
	const parsed = words(input);
	const [action, ...tail] = parsed.map((word) => word.value);
	if (action === "help" || action === "presets" || action === "list" || action === "stats" || action === "install") {
		if (tail.length !== 0) throw new Error(`Unexpected arguments after "${action}".`);
		return { action };
	}
	if (action === "panes") {
		if (tail.length === 0) return { action };
		const limit = Number(tail[0]);
		if (tail.length !== 1 || !/^\d+$/.test(tail[0]!) || !Number.isSafeInteger(limit)) {
			throw new Error("Usage: /agents panes [K] - K must be a nonnegative safe integer.");
		}
		return { action, limit };
	}
	if (action === "footer") {
		if (tail.length !== 1 || (tail[0] !== "alwaysOn" && tail[0] !== "activity")) {
			throw new Error("Usage: /agents footer alwaysOn|activity");
		}
		return { action, alwaysOn: tail[0] === "alwaysOn" };
	}
	if (action === "status") {
		if (tail.length !== 1) throw new Error("Usage: /agents status <agent-name>");
		return { action, name: tail[0]! };
	}
	if (action === "send") {
		if (parsed.length < 2) throw new Error("Usage: /agents send <agent-name> <message>");
		const name = parsed[1]!.value;
		const message = input.slice(parsed[1]!.end).trim();
		if (message === "") throw new Error("Usage: /agents send <agent-name> <message>");
		return { action, name, message };
	}
	if (action === "stop") {
		if (tail.length === 1 && tail[0] === "--all") return { action: "stop-all" };
		if (tail.length !== 1) throw new Error("Usage: /agents stop <agent-name> | /agents stop --all");
		return { action, name: tail[0]! };
	}
	throw new Error("Unknown /agents action. Use /agents help.");
}
