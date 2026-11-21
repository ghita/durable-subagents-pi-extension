import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionLogger } from "../src/logger.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ExtensionLogger", () => {
	it("appends readable exception details to the shared extension log", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-durable-subagents-log-"));
		directories.push(agentDir);
		const logger = new ExtensionLogger(agentDir, "error");

		await Promise.all([
			logger.logDebug("runtime", "open_started"),
			logger.logException("runtime", "session_start_failed", new Error("runtime failed")),
			logger.logException("herdr", "agent_update_failed", "pane unavailable"),
		]);

		expect(logger.filePath).toBe(join(agentDir, "logs", "durable-subagents.log"));
		const contents = await readFile(logger.filePath, "utf8");
		expect(contents).toMatch(/\[\d{4}-\d{2}-\d{2}T[^\]]+\] ERROR \[runtime\] session_start_failed/);
		expect(contents).toContain("Error: runtime failed");
		expect(contents).toContain("[herdr] agent_update_failed");
		expect(contents).toContain("pane unavailable");
		expect(contents).not.toContain("DEBUG");
	});

	it("writes debug events only when debug level is enabled", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-durable-subagents-debug-log-"));
		directories.push(agentDir);
		const logger = new ExtensionLogger(agentDir, "debug");

		await logger.logDebug("runtime", "open_started");

		const contents = await readFile(logger.filePath, "utf8");
		expect(contents).toMatch(/\[\d{4}-\d{2}-\d{2}T[^\]]+\] DEBUG \[runtime\] open_started/);
	});
});
