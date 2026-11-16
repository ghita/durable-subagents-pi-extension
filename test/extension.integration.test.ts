import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import durableSubagents from "../src/index.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi extension integration", () => {
	it("registers the command and model tool against one persistent runtime and delivers a custom report", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagents-extension-"));
		directories.push(directory);
		const sessionFile = join(directory, "transcript.jsonl");
		await writeFile(sessionFile, "", "utf8");

		const faux = fauxProvider({
			tokensPerSecond: 100_000,
			models: [{ id: "faux-parent" }, { id: "faux-next" }],
		});
		faux.setResponses([fauxAssistantMessage("The delegated answer.")]);
		const providerModels = createModels();
		providerModels.setProvider(faux.provider);
		const model = faux.getModel() as Model<any>;
		const streamSimple = vi.spyOn(providerModels, "streamSimple");
		const modelRegistry = {
			getRegisteredProviderIds: () => [model.provider],
			getProvider: (id: string) => providerModels.getProvider(id),
			getAll: () => [...providerModels.getModels()],
			getAvailable: () => [...providerModels.getModels()],
			find: (provider: string, id: string) => providerModels.getModel(provider, id),
			getModelsOfType: (type: "chat" | "image" | "classifier", provider?: string) => providerModels.getModelsOfType(type, provider),
			getAvailableOfType: (type: "chat" | "image" | "classifier", provider?: string) => providerModels.getAvailableOfType(type, provider),
			getModelOfType: (type: "chat" | "image" | "classifier", provider: string, id: string) => providerModels.getModelOfType(type, provider, id),
			refresh: () => providerModels.refresh(),
			getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
			getProviderAuth: (provider: string) => providerModels.getAuth(provider),
			stream: (...args: Parameters<typeof providerModels.stream>) => providerModels.stream(...args),
			complete: (...args: Parameters<typeof providerModels.complete>) => providerModels.complete(...args),
			streamSimple: (...args: Parameters<typeof providerModels.streamSimple>) => providerModels.streamSimple(...args),
			generateImages: (...args: Parameters<typeof providerModels.generateImages>) => providerModels.generateImages(...args),
			classify: (...args: Parameters<typeof providerModels.classify>) => providerModels.classify(...args),
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;

		const entries: Array<{ type: string; customType?: string; details?: unknown }> = [];
		const messages: Array<{ message: unknown; options: unknown }> = [];
		const notifications: string[] = [];
		const commands = new Map<string, { handler(args: string, context: any): Promise<void>; getArgumentCompletions(prefix: string): Promise<any> | any }>();
		const tools = new Map<string, any>();
		const handlers = new Map<string, Array<(event: any, context: any) => Promise<void> | void>>();
		const ui = { notify: (message: string) => notifications.push(message) };
		const sessionManager = {
			getSessionFile: () => sessionFile,
			getEntries: () => [...entries],
			getCwd: () => process.cwd(),
		};
		let currentThinking = "off";
		const contextState = {
			ui,
			mode: "print",
			hasUI: false,
			cwd: process.cwd(),
			sessionManager,
			modelRegistry,
			model,
			thinkingLevel: currentThinking,
			isIdle: () => true,
			isProjectTrusted: () => true,
			signal: undefined,
			abort: () => undefined,
			hasPendingMessages: () => false,
			shutdown: () => undefined,
			getContextUsage: () => undefined,
			getSystemPrompt: () => "",
			waitForIdle: async () => undefined,
			getSystemPromptOptions: () => ({}),
		};
		const context = contextState as unknown as ExtensionContext;
		const commandContext = context as any;
		const pi = {
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerTool: (tool: any) => tools.set(tool.name, tool),
			on: (event: string, handler: (event: any, context: any) => Promise<void> | void) => {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
				return () => undefined;
			},
			sendMessage: (message: any, options: any) => {
				messages.push({ message, options });
				entries.push({ type: "custom_message", customType: message.customType, details: message.details });
			},
			getThinkingLevel: () => currentThinking,
		} as unknown as ExtensionAPI;

		await durableSubagents(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, context);
		expect(commands.has("agents")).toBe(true);
		expect(tools.has("subagent")).toBe(true);

		const tool = tools.get("subagent")!;
		const toolResult = (await tool.execute(
			"tool-1",
			{ action: "spawn", name: "analyst", message: "Inspect the sample and summarize it." },
			undefined,
			undefined,
			context as ExtensionToolContext,
		)) as AgentToolResult;
		expect(toolResult.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("Started analyst") });

		const deadline = Date.now() + 5_000;
		while (messages.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(messages).toHaveLength(1);
		expect(messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(messages[0]?.message).toMatchObject({
			customType: "durable-subagent-report",
			content: expect.stringContaining("The delegated answer."),
			details: { agentName: "analyst" },
		});

		await commands.get("agents")!.handler("list", commandContext);
		expect(notifications.join("\n")).toContain("analyst");
		expect(await commands.get("agents")!.getArgumentCompletions("status ")).toEqual([
			{ value: "analyst", label: "analyst" },
		]);

		const nextModel = providerModels.getModel(model.provider, "faux-next")!;
		contextState.model = nextModel;
		await handlers.get("model_select")?.[0]?.({ type: "model_select", model: nextModel }, context);
		currentThinking = "high";
		contextState.thinkingLevel = currentThinking;
		await handlers.get("thinking_level_select")?.[0]?.({ type: "thinking_level_select", level: currentThinking }, context);
		faux.appendResponses([fauxAssistantMessage("Follow-up on the updated model.")]);
		await commands.get("agents")!.handler("send analyst Continue using the inherited settings.", commandContext);
		const followUpDeadline = Date.now() + 5_000;
		while (messages.length < 2 && Date.now() < followUpDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(messages).toHaveLength(2);
		expect(messages[1]?.message).toMatchObject({
			content: expect.stringContaining("Follow-up on the updated model."),
		});
		expect(streamSimple.mock.calls.some(([usedModel]) => usedModel.id === "faux-next")).toBe(true);

		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "resume" }, context);
		await commands.get("agents")!.handler("list", commandContext);
		expect(notifications.at(-1)).toContain("analyst");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
	});
});
