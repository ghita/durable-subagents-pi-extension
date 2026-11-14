import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createPiModelBridge } from "../src/model-bridge.ts";

/**
 * Opt-in live smoke extension. Run with `PI_DURABLE_BRIDGE_RESULT=<path> pi ...`
 * so the request uses the host session's actual ModelRegistry and login.
 */
export default function copilotBridgeSmoke(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const resultPath = process.env.PI_DURABLE_BRIDGE_RESULT;
		if (resultPath === undefined) return;

		try {
			const model = ctx.model as Model<any> | undefined;
			if (model === undefined || model.provider !== "github-copilot") {
				throw new Error(`Expected a selected github-copilot model, got ${model?.provider ?? "no model"}`);
			}
			const response = await createPiModelBridge(ctx.modelRegistry).completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with exactly: durable bridge ok", timestamp: Date.now() }] },
				{ maxTokens: 32 },
			);
			const text = response.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			await writeFile(resultPath, JSON.stringify({ provider: model.provider, model: model.id, text }), "utf8");
		} catch (error) {
			await writeFile(
				resultPath,
				JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
				"utf8",
			);
		}
	});
}
