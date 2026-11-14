export function validateAgentName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new Error("An agent needs a meaningful, non-empty name.");
	if (trimmed.length > 80) throw new Error("Agent names must be 80 characters or fewer.");
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error("Agent names cannot contain control characters.");
	if (trimmed === "__proto__") throw new Error('The agent name "__proto__" is reserved.');
	return trimmed;
}

/** Resolve collisions against every registered agent, including idle agents. */
export function uniqueAgentName(requested: string, registered: Readonly<Record<string, unknown>>): string {
	const base = validateAgentName(requested);
	if (!Object.hasOwn(registered, base)) return base;
	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!Object.hasOwn(registered, candidate)) return candidate;
	}
}
