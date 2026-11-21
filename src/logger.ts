import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

function oneLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 120) || "unknown";
}

function exceptionText(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		try {
			return String(error);
		} catch {
			return "<unprintable exception>";
		}
	}
}

/** Appends extension diagnostics to one user-level plain text log shared across sessions. */
export class ExtensionLogger {
	readonly filePath: string;
	#debugEnabled: boolean;
	#pendingWrite: Promise<void> = Promise.resolve();

	constructor(agentDir: string, level = process.env.PI_DURABLE_SUBAGENTS_LOG_LEVEL) {
		this.filePath = join(agentDir, "logs", "durable-subagents.log");
		this.#debugEnabled = level?.trim().toLowerCase() === "debug";
	}

	flush(): Promise<void> {
		return this.#pendingWrite;
	}

	logDebug(component: string, event: string): Promise<void> {
		if (!this.#debugEnabled) return Promise.resolve();
		return this.#append(`[${new Date().toISOString()}] DEBUG [${oneLine(component)}] ${oneLine(event)}\n\n`);
	}

	logException(component: string, event: string, error: unknown): Promise<void> {
		const details = exceptionText(error).split(/\r?\n/).map((line) => `  ${line}`).join("\n");
		return this.#append(`[${new Date().toISOString()}] ERROR [${oneLine(component)}] ${oneLine(event)}\n${details}\n\n`);
	}

	#append(entry: string): Promise<void> {
		const write = this.#pendingWrite.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			await appendFile(this.filePath, entry, "utf8");
		});
		this.#pendingWrite = write.catch((loggingError) => {
			// Logging must not replace the original exception or create another rejected promise.
			console.error("[durable-subagents] Could not write extension log:", loggingError);
		});
		return this.#pendingWrite;
	}
}
