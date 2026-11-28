import { access } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

export const PERSISTENT_SESSION_REQUIRED = "Persistent Pi session required: durable subagents cannot run in an ephemeral session.";

export function requireSessionFile(sessionFile: string | undefined): string {
	if (sessionFile === undefined || sessionFile.trim() === "") throw new Error(PERSISTENT_SESSION_REQUIRED);
	return resolve(sessionFile);
}

/** Stable adjacent sidecar name, derived solely from the transcript being resumed. */
export function durableDatabasePath(sessionFile: string | undefined): string {
	const transcript = requireSessionFile(sessionFile);
	const name = basename(transcript, extname(transcript));
	return resolve(dirname(transcript), `${name}.durable.sqlite`);
}

/** Check for a sidecar without creating it; used to decide whether startup should resume Durable. */
export async function durableDatabaseExists(sessionFile: string | undefined): Promise<boolean> {
	try {
		await access(durableDatabasePath(sessionFile));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
		throw error;
	}
}

