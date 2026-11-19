import { Type } from "typebox";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentService } from "./agent-service.ts";
import { AgentFooterController } from "./footer.ts";
import { getAgentCompletions } from "./autocomplete.ts";
import { parseAgentsCommand } from "./command-parser.ts";
import { formatAgentList, formatAgentSummary, formatHelp, formatPresets, formatStats } from "./format.ts";
import { modelReference } from "./model-bridge.ts";
import { loadPresetCatalog } from "./presets.ts";
import { openManagedSessionRuntime, type ManagedSessionRuntime, requireSessionFile } from "./runtime.ts";

const SubagentParameters = Type.Object({
	action: Type.Union([
		Type.Literal("spawn"),
		Type.Literal("send"),
		Type.Literal("list"),
		Type.Literal("status"),
		Type.Literal("stop"),
		Type.Literal("stop-all"),
		Type.Literal("stats"),
	]),
	name: Type.Optional(Type.String({ description: "Meaningful registered agent name; required for send/status/stop" })),
	presetId: Type.Optional(Type.String({ description: "Optional cached preset ID for spawn" })),
	message: Type.Optional(Type.String({ description: "Initial task for spawn or instruction for send" })),
});

let activeRuntime: ManagedSessionRuntime | undefined;
let activeFooter: { runtime: ManagedSessionRuntime; controller: AgentFooterController } | undefined;
let footerAlwaysOn = false;
let opening: { sessionFile: string; promise: Promise<ManagedSessionRuntime> } | undefined;
let propagation = Promise.resolve();

function stopFooter(): void {
	activeFooter?.controller.dispose();
	activeFooter = undefined;
}

function ensureFooter(context: ExtensionContext, runtime: ManagedSessionRuntime): void {
	if (context.mode !== "tui") {
		if (activeFooter?.runtime === runtime) stopFooter();
		return;
	}
	if (activeFooter?.runtime === runtime) {
		activeFooter.controller.wake();
		return;
	}
	stopFooter();
	const controller = new AgentFooterController(context, runtime.service, footerAlwaysOn);
	activeFooter = { runtime, controller };
	controller.wake();
}

async function getRuntime(pi: ExtensionAPI, context: ExtensionContext): Promise<ManagedSessionRuntime> {
	const sessionFile = requireSessionFile(context.sessionManager.getSessionFile());
	if (activeRuntime?.sessionFile === sessionFile) {
		ensureFooter(context, activeRuntime);
		return activeRuntime;
	}
	if (opening?.sessionFile === sessionFile) {
		const runtime = await opening.promise;
		ensureFooter(context, runtime);
		return runtime;
	}
	if (activeRuntime !== undefined) {
		const previous = activeRuntime;
		activeRuntime = undefined;
		stopFooter();
		await previous.close();
	}

	const promise = openManagedSessionRuntime(pi, context);
	opening = { sessionFile, promise };
	try {
		const runtime = await promise;
		activeRuntime = runtime;
		ensureFooter(context, runtime);
		return runtime;
	} finally {
		if (opening?.promise === promise) opening = undefined;
	}
}

async function notifyCommand(context: ExtensionContext, action: () => Promise<string>): Promise<void> {
	try {
		context.ui.notify(await action(), "info");
	} catch (error) {
		context.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		activeFooter?.controller.wake();
	}
}

function describePresetIds(ids: readonly string[]): string {
	return ids.length === 0 ? "No configured presets are currently cached." : `Cached presets: ${ids.join(", ")}.`;
}

async function runToolAction(
	service: AgentService,
	args: { action: string; name?: string; presetId?: string; message?: string },
): Promise<{ text: string; details?: unknown }> {
	if (args.action === "list") return { text: formatAgentList(await service.list()) };
	if (args.action === "status") {
		return args.name === undefined
			? { text: formatAgentList(await service.list()) }
			: { text: formatAgentSummary(await service.status(args.name)) };
	}
	if (args.action === "stats") {
		const stats = await service.stats();
		return { text: formatStats(stats.total, stats.rows) };
	}
	if (args.action === "stop-all") {
		const stopped = await service.stopAll();
		return { text: stopped.length === 0 ? "No active managed agents." : `Stopped: ${stopped.join(", ")}.` };
	}
	if (args.action === "stop") {
		if (args.name === undefined) throw new Error("stop needs a managed agent name.");
		await service.stop(args.name);
		return { text: `Stopped ${args.name}; its durable conversation and history are retained.` };
	}
	if (args.action === "spawn") {
		if (args.message === undefined || args.message.trim() === "") throw new Error("spawn needs a task message.");
		const result = await service.spawn(args.name, args.presetId, args.message);
		return {
			text: `Started ${result.name}; the agent is working independently and will report when finished.`,
			details: { name: result.name, conversationId: result.conversationId },
		};
	}
	if (args.action === "send") {
		if (args.name === undefined || args.message === undefined || args.message.trim() === "") {
			throw new Error("send needs an agent name and a non-empty message.");
		}
		const result = await service.send(args.name, args.message);
		return { text: `Sent a steering instruction to ${args.name}.`, details: { name: args.name, reporterTaskId: result.reporterTaskId } };
	}
	throw new Error(`Unknown subagent action "${args.action}".`);
}

export default async function durableSubagents(pi: ExtensionAPI): Promise<void> {
	// Loading at extension initialization makes the preset view stable until Pi reloads this extension.
	const presetCatalog = await loadPresetCatalog(getAgentDir());
	const presetIds = [...presetCatalog.valid.keys()].sort((a, b) => a.localeCompare(b));

	async function agentNames(): Promise<string[]> {
		if (activeRuntime === undefined) return [];
		try {
			return (await activeRuntime.service.list()).map((agent) => agent.name);
		} catch {
			return [];
		}
	}

	pi.registerCommand("agents", {
		description: `Manage persistent named background agents. ${describePresetIds(presetIds)}`,
		getArgumentCompletions: async (prefix) => {
			const names = await agentNames();
			return getAgentCompletions(prefix, presetIds, names);
		},
		handler: async (args, context) => {
			await notifyCommand(context, async () => {
				const command = parseAgentsCommand(args);
				if (command.action === "help") return formatHelp(presetCatalog);
				if (command.action === "presets") return formatPresets(presetCatalog);
				if (command.action === "footer") {
					footerAlwaysOn = command.alwaysOn;
					activeFooter?.controller.setAlwaysOn(footerAlwaysOn);
					if (context.mode === "tui") await getRuntime(pi, context);
					return footerAlwaysOn
						? "Agent footer is always on, including when no agents are running."
						: "Agent footer now appears only during activity (and for the three-second hide delay).";
				}
				const runtime = await getRuntime(pi, context);
				if (command.action === "list") return formatAgentList(await runtime.service.list());
				if (command.action === "status") return formatAgentSummary(await runtime.service.status(command.name));
				if (command.action === "stats") {
					const stats = await runtime.service.stats();
					return formatStats(stats.total, stats.rows);
				}
				if (command.action === "stop-all") {
					const stopped = await runtime.service.stopAll();
					return stopped.length === 0 ? "No active managed agents." : `Stopped: ${stopped.join(", ")}.`;
				}
				if (command.action === "stop") {
					await runtime.service.stop(command.name);
					return `Stopped ${command.name}; its durable conversation and history are retained.`;
				}
				if (command.action === "send") {
					await runtime.service.send(command.name, command.message);
					return `Sent a steering instruction to ${command.name}.`;
				}
				if (command.action === "spawn") {
					const result = await runtime.service.spawn(command.name, command.presetId, command.message);
					return `Started ${result.name}; the agent is working independently and will report when finished.`;
				}
				throw new Error(`Unsupported /agents action "${command.action}".`);
			});
		},
	});

	pi.registerTool({
		name: "durable_subagent",
		label: "Durable Subagent",
		promptSnippet: "Spawn, steer, inspect, and stop persistent named background agents.",
		description:
			"Manage persistent named background agents. Actions: spawn (choose a meaningful name, optional presetId, and task), send (name and message; steers busy work), list, status (optionally name), stop (name), stop-all, stats. " +
			`Choose a relevant configured preset when useful. ${describePresetIds(presetIds)} If no preset applies, all durable-native coding tools are enabled. Reports return as extension-authored follow-up messages.`,
		parameters: SubagentParameters,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		execute: async (_toolCallId, args, _signal, _onUpdate, context: ExtensionToolContext) => {
			try {
				const runtime = await getRuntime(pi, context);
				const result = await runToolAction(runtime.service, args);
				return {
					content: [{ type: "text" as const, text: result.text }],
					details: result.details ?? {},
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			} finally {
				activeFooter?.controller.wake();
			}
		},
	});

	pi.on("session_start", async (_event, context) => {
		if (context.sessionManager.getSessionFile() === undefined) return;
		try {
			await getRuntime(pi, context);
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_shutdown", async (_event, context) => {
		const previous = activeRuntime;
		activeRuntime = undefined;
		stopFooter();
		if (previous !== undefined) {
			try {
				await previous.close();
			} catch (error) {
				context.ui.notify(`Durable subagent shutdown failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	});

	pi.on("model_select", async (event, context) => {
		const runtime = activeRuntime;
		if (runtime === undefined) return;
		const ref = modelReference(event.model as Model<any>);
		const thinking = (pi.getThinkingLevel() ?? context.thinkingLevel ?? "off") as ModelThinkingLevel;
		propagation = propagation
			.then(() => runtime.service.updateInherited(ref, thinking))
			.catch((error) => context.ui.notify(`Could not update inherited agent model: ${error instanceof Error ? error.message : String(error)}`, "error"));
		await propagation;
	});

	pi.on("thinking_level_select", async (event, context) => {
		const runtime = activeRuntime;
		const model = context.model as Model<any> | undefined;
		if (runtime === undefined || model === undefined) return;
		const ref = modelReference(model);
		const thinking = event.level as ModelThinkingLevel;
		propagation = propagation
			.then(() => runtime.service.updateInherited(ref, thinking))
			.catch((error) => context.ui.notify(`Could not update inherited agent thinking: ${error instanceof Error ? error.message : String(error)}`, "error"));
		await propagation;
	});
}
