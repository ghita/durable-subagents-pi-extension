import { Type } from "typebox";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AgentService } from "./agent-service.ts";
import { AgentFooterController } from "./footer.ts";
import { getAgentCompletions } from "./autocomplete.ts";
import { parseAgentsCommand } from "./command-parser.ts";
import { describePresetsForAgent, formatAgentList, formatAgentSummary, formatHelp, formatPresets, formatStats } from "./format.ts";
import { modelReference } from "./model-bridge.ts";
import { installPackagedPresets, loadPackagedPresets, loadPresetCatalog } from "./presets.ts";
import { openManagedSessionRuntime, type ManagedSessionRuntime, requireSessionFile } from "./runtime.ts";
import { durableDatabaseExists } from "./storage-path.ts";
const SubagentParameters = Type.Object({
	action: Type.Union([
		Type.Literal("spawn", { description: "Start a named agent asynchronously. Returns an acknowledgment; its report is steered to the main agent at the next model-call boundary." }),
		Type.Literal("send", { description: "Submit a new task to an existing agent asynchronously. This does not fetch an existing report." }),
		Type.Literal("list", { description: "Return agent status snapshots only; does not include report text." }),
		Type.Literal("status", { description: "Return one agent's status snapshot only; idle does not mean its report is included here." }),
		Type.Literal("stop", { description: "Stop an agent's current work while retaining its conversation and history." }),
		Type.Literal("stop-all", { description: "Stop all currently active managed agents." }),
		Type.Literal("stats", { description: "Return cumulative managed-agent usage and costs." }),
	]),
	name: Type.Optional(Type.String({ description: "Meaningful agent name; required for send/status/stop and optional for spawn when presetId is supplied." })),
	presetId: Type.Optional(Type.String({ description: "Optional cached preset ID for spawn. If omitted, a matching preset name is selected automatically." })),
	message: Type.Optional(Type.String({ description: "Task for spawn or a new task/instruction for send. send creates new work; it is not a result lookup." })),
});

let activeRuntime: ManagedSessionRuntime | undefined;
let activeFooter: { runtime: ManagedSessionRuntime; controller: AgentFooterController } | undefined;
let footerAlwaysOn = false;
// Runtime-only, deliberately outside individual managed-session runtimes.
let paneLimit = 3;
let runtimeEpoch = 0;
let runtimeTail: Promise<unknown> = Promise.resolve();
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
	const controller = new AgentFooterController(context, runtime.service, footerAlwaysOn, () => undefined);
	activeFooter = { runtime, controller };
	controller.wake();
}

function serializeRuntime<T>(action: () => Promise<T>): Promise<T> {
	const next = runtimeTail.then(action);
	runtimeTail = next.catch(() => undefined);
	return next;
}

async function getRuntime(pi: ExtensionAPI, context: ExtensionContext): Promise<ManagedSessionRuntime> {
	const sessionFile = requireSessionFile(context.sessionManager.getSessionFile());
	const epoch = runtimeEpoch;
	return serializeRuntime(async () => {
		if (epoch !== runtimeEpoch) throw new Error("Managed-agent session changed while opening its runtime.");
		if (activeRuntime?.sessionFile !== sessionFile) {
			const previous = activeRuntime;
			activeRuntime = undefined;
			stopFooter();
			await previous?.close();
			if (epoch !== runtimeEpoch) throw new Error("Managed-agent session changed while opening its runtime.");
			const runtime = await openManagedSessionRuntime(pi, context, paneLimit);
			if (epoch !== runtimeEpoch) {
				await runtime.close();
				throw new Error("Managed-agent session changed while opening its runtime.");
			}
			activeRuntime = runtime;
		}
		const runtime = activeRuntime;
		// The preference may have changed while opening, or startup/reload may
		// have reset it while a runtime was already present.
		if (runtime.herdrMonitor !== undefined && runtime.herdrMonitor.paneLimit !== paneLimit) {
			try { await runtime.herdrMonitor.setPaneLimit(paneLimit); }
			catch (error) { runtime.reportDisplayError(error); }
		}
		if (epoch !== runtimeEpoch) throw new Error("Managed-agent session changed while opening its runtime.");
		ensureFooter(context, runtime);
		return runtime;
	});
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

const STATUS_SNAPSHOT_GUIDANCE =
	"Status snapshot only—not the agent's report. Idle means no work is active; a completed report may still be queued until the next model call. Messages in/out counts accepted instructions/reports recorded in Pi. Reports arrive separately as steering messages; do not poll status/list or send the task again to retrieve one.";

async function observeAgent(runtime: ManagedSessionRuntime, name: string, conversationId: ConversationId): Promise<void> {
	try {
		await runtime.herdrMonitor?.trackAgent(name, conversationId);
	} catch (error) {
		runtime.reportDisplayError(error);
	}
}

async function runToolAction(
	runtime: ManagedSessionRuntime,
	args: { action: string; name?: string; presetId?: string; message?: string },
): Promise<{ text: string; details?: unknown }> {
	const { service } = runtime;
	if (args.action === "list") return { text: `${formatAgentList(await service.list())}\n\n${STATUS_SNAPSHOT_GUIDANCE}` };
	if (args.action === "status") {
		const snapshot = args.name === undefined
			? formatAgentList(await service.list())
			: formatAgentSummary(await service.status(args.name));
		return { text: `${snapshot}\n\n${STATUS_SNAPSHOT_GUIDANCE}` };
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
		await observeAgent(runtime, result.name, result.conversationId);
		return {
			text: `Started ${result.name} asynchronously. This is an acknowledgment, not the result. Its report arrives separately as a Pi steering message; if the main agent is busy, it is delivered at the next model call after the current tool batch completes. Continue other work meanwhile; do not poll status/list or resend the task to retrieve the report.`,
			details: { name: result.name, conversationId: result.conversationId },
		};
	}
	if (args.action === "send") {
		if (args.name === undefined || args.message === undefined || args.message.trim() === "") {
			throw new Error("send needs an agent name and a non-empty message.");
		}
		const result = await service.send(args.name, args.message);
		await observeAgent(runtime, args.name, result.conversationId);
		return {
			text: `Submitted a new task to ${args.name} asynchronously. This is an acknowledgment, not the result; its report will arrive separately as a Pi steering message at the next model call. Sending again creates additional work and does not retrieve a pending report.`,
			details: { name: args.name, reporterTaskId: result.reporterTaskId },
		};
	}
	throw new Error(`Unknown subagent action "${args.action}".`);
}

export default async function durableSubagents(pi: ExtensionAPI): Promise<void> {
	// Loading at extension initialization makes the preset view stable until Pi reloads this extension.
	const agentDir = getAgentDir();
	const presetCatalog = await loadPresetCatalog(agentDir);
	const packagedPresets = await loadPackagedPresets();
	const presetIds = [...presetCatalog.valid.keys()].sort((a, b) => a.localeCompare(b));
	const presetGuidance = describePresetsForAgent(presetCatalog);

	async function agentNames(): Promise<string[]> {
		if (activeRuntime === undefined) return [];
		try {
			return (await activeRuntime.service.list()).map((agent) => agent.name);
		} catch {
			return [];
		}
	}

	pi.registerCommand("agents", {
		description: `Manage persistent named background agents. ${presetGuidance}`,
		getArgumentCompletions: async (prefix) => {
			if (/^panes\s/.test(prefix)) {
				const match = prefix.match(/^(panes\s+)(\d*)$/);
				if (match === null) return null;
				return ["0", "1", "2", "3", "4", "5"].filter((value) => value.startsWith(match[2]!))
					.map((value) => ({ value: match[1] + value, label: value }));
			}
			const names = await agentNames();
			const items = getAgentCompletions(prefix, presetIds, names);
			if (!/\s/.test(prefix) && "panes".startsWith(prefix.toLowerCase())) {
				return [...(items ?? []), { value: "panes", label: "panes" }];
			}
			return items;
		},
		handler: async (args, context) => {
			await notifyCommand(context, async () => {
				const command = parseAgentsCommand(args);
				if (command.action === "help") return `${formatHelp(presetCatalog)}
/agents panes [K] - show or set the current tab's agent-display budget (default 3; 0 disables displays).`;
				if (command.action === "presets") return formatPresets(presetCatalog, packagedPresets);
				if (command.action === "install") {
					const result = await installPackagedPresets(agentDir, packagedPresets);
					const installed = result.installed.length === 0
						? "No new packaged presets installed."
						: `Installed packaged presets: ${result.installed.join(", ")}. Run /reload before using the newly installed presets.`;
					const skipped = result.skipped.length === 0
						? ""
						: ` Skipped existing preset IDs without overwriting them: ${result.skipped.join(", ")}.`;
					return `${installed}${skipped}`;
				}
				if (command.action === "panes") {
					if (command.limit !== undefined) {
						// Set before opening a runtime: K=0 must never transiently restore panes.
						paneLimit = command.limit;
						const runtime = await getRuntime(pi, context);
						try {
							await runtime.herdrMonitor?.setPaneLimit(paneLimit);
						} catch (error) {
							runtime.reportDisplayError(error);
							return `Agent-display pane budget: ${paneLimit}. Display reconciliation failed; agent work continues and reconciliation will retry.`;
						}
					}
					return `Agent-display pane budget: ${paneLimit} for the current Herdr tab (0 disables displays). Runtime-only; resets to 3 on extension reload or Pi restart.`;
				}
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
					const result = await runtime.service.send(command.name, command.message);
					await observeAgent(runtime, command.name, result.conversationId);
					return `Sent a steering instruction to ${command.name}.`;
				}
				if (command.action === "spawn") {
					const result = await runtime.service.spawn(command.name, command.presetId, command.message);
					await observeAgent(runtime, result.name, result.conversationId);
					return `Started ${result.name}; the agent is working independently and will report when finished.`;
				}
				throw new Error(`Unsupported /agents action "${command.action}".`);
			});
		},
	});

	pi.registerTool({
		name: "durable_subagent",
		label: "Durable Subagent",
		promptSnippet: "Manage persistent agents asynchronously. spawn/send return acknowledgments, not results; completed reports arrive separately as Pi steering messages at the next model-call boundary after current tool calls. list/status are status snapshots only, never report retrieval. Idle means no active work, not necessarily that the report has been delivered. Do not poll or resend to fetch a report.",
		description:
			"Manage persistent named background agents. spawn and send are asynchronous: they acknowledge accepted work but do not return its answer. The completed answer is delivered separately as an extension-authored Pi steering message; if Pi is busy, it is queued for the next model call after current tool calls finish. list/status return state, usage, and message counts only—not report text. Idle means no work is active; it does not guarantee the report is already in the main transcript. Do not poll list/status or send the task again to retrieve an answer. Actions: spawn (name/presetId/message), send (name/message; creates new work), list, status (optionally name), stop, stop-all, stats. " +
			`Choose a relevant configured preset when useful. ${presetGuidance} If no preset applies, all durable-native coding tools are enabled.`,
		parameters: SubagentParameters,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		execute: async (_toolCallId, args, _signal, _onUpdate, context: ExtensionToolContext) => {
			try {
				const runtime = await getRuntime(pi, context);
				const result = await runToolAction(runtime, args);
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

	pi.on("session_start", async (event, context) => {
		if (event.reason === "reload" || event.reason === "startup") paneLimit = 3;
		const sessionFile = context.sessionManager.getSessionFile();
		if (sessionFile === undefined) return;
		try {
			// Opening Durable creates the SQLite file. Resume automatically only when
			// this transcript already has managed-agent state; first use stays lazy.
			if (!(await durableDatabaseExists(sessionFile))) {
				// A session switch still retires the previous session's runtime even
				// when the new session has no sidecar to open.
				const targetSessionFile = requireSessionFile(sessionFile);
				await serializeRuntime(async () => {
					if (activeRuntime?.sessionFile === targetSessionFile) return;
					const previous = activeRuntime;
					activeRuntime = undefined;
					stopFooter();
					await previous?.close();
				});
				return;
			}
			await getRuntime(pi, context);
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_shutdown", async (_event, context) => {
		// Invalidate pending opens immediately, then wait for their cleanup before
		// closing the active runtime. A late open must never resurrect this session.
		runtimeEpoch += 1;
		await serializeRuntime(async () => {
			const previous = activeRuntime;
			activeRuntime = undefined;
			stopFooter();
			if (previous !== undefined) {
				try { await previous.close(); }
				catch (error) {
					context.ui.notify(`Durable subagent shutdown failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		});
	});

	pi.on("model_select", async (event, context) => {
		const runtime = activeRuntime;
		if (runtime === undefined) return;
		const ref = modelReference(event.model as Model<any>);
		const thinking = (pi.getThinkingLevel() ?? context.thinkingLevel ?? "off") as ModelThinkingLevel;
		propagation = propagation
			.then(() => runtime.service.updateInherited(ref, thinking))
			.catch(async (error) => {
				context.ui.notify(`Could not update inherited agent model: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
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
			.catch(async (error) => {
				context.ui.notify(`Could not update inherited agent thinking: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
		await propagation;
	});
}
