import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

type SmokeResult = { provider?: string; model?: string; text?: string; error?: string };

const directory = await mkdtemp(join(tmpdir(), "pi-durable-model-bridge-"));
const resultPath = join(directory, "result.json");
const extensionPath = resolve("test/model-bridge-smoke-extension.ts");
const selectedModel = process.env.PI_DURABLE_MODEL?.trim();
const modelArgs = selectedModel ? ["--model", selectedModel] : [];

try {
	const output = await new Promise<string>((resolveOutput, reject) => {
		const child = spawn(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--extension",
				extensionPath,
				"--no-tools",
				...modelArgs,
				"--print",
				"Reply with exactly: main turn ok.",
			],
			{
				env: { ...process.env, PI_DURABLE_BRIDGE_RESULT: resultPath },
				shell: process.platform === "win32",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let captured = "";
		child.stdout.setEncoding("utf8").on("data", (part: string) => (captured += part));
		child.stderr.setEncoding("utf8").on("data", (part: string) => (captured += part));
		child.once("error", reject);
		child.once("close", (code) => (code === 0 ? resolveOutput(captured) : reject(new Error(`pi exited ${code}: ${captured}`))));
	});
	const result = JSON.parse(await readFile(resultPath, "utf8")) as SmokeResult;
	if (result.error !== undefined) throw new Error(result.error);
	if (result.provider === undefined || !result.text?.toLowerCase().includes("durable bridge ok")) {
		throw new Error(`Unexpected bridge result: ${JSON.stringify(result)}\nPi output: ${output}`);
	}
	console.log(`Pi ModelRegistry bridge succeeded with ${result.provider}/${result.model}: ${result.text}`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
