import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, withTelemetry } from "@earendil-works/chord/context";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import {
	AssistantEntry,
	configure,
	LiveDoc,
	ToolResultEntry,
	type ConversationId,
	type Conversation,
	type Cursor,
	type EntryId,
	type Harness,
	type ModelRef,
	type TaskId,
	type Tx,
	UsageDoc,
	type UsageState,
	type Extension,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { getPresetOrFallback, type AgentPreset, type PresetCatalog } from "./presets.ts";
import { uniqueAgentName, validateAgentName } from "./names.ts";
import { SubagentsDoc, type ManagedAgentRecord, type ManagedReportRecord, type SubagentsState } from "./agent-state.ts";
import { AgentReporter, AgentAnchor } from "./tasks.ts";
import { cappedContentAttributes, inTelemetrySpan } from "./telemetry.ts";

export interface AgentSummary {
	name: string;
	conversationId: ConversationId;
	active: boolean;
	presetId: string | null;
	incomingCount: number;
	outgoingCount: number;
	usage: UsageTotals;
}

export interface AgentFooterSummary extends AgentSummary {
	/** A reporter task exists but the child conversation has not started running yet. */
	queued: boolean;
	modelLabel: string;
	thinkingLevel: ModelThinkingLevel;
	turns: number;
	toolUses: number;
	contextTokens: number | null;
	contextWindow: number | null;
	latestTask: string;
	fresh: boolean;
}

type AgentHistoryCounts = {
	lastEntryId?: EntryId;
	turns: number;
	toolUses: number;
	contextTokens: number | null;
};

const NON_EXECUTED_TOOL_DIAGNOSTICS = new Set(["aborted", "blocked", "invalid_arguments", "tool_unavailable"]);
const HISTORY_PAGE_SIZE = 256;

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface StatsRow {
	name: string;
	usage: UsageTotals;
}

export interface SpawnResult {
	name: string;
	conversationId: ConversationId;
	reporterTaskId: TaskId<null>;
}

export interface MessageResult {
	reporterTaskId: TaskId<null>;
	requestId: string;
	conversationId: ConversationId;
}

export interface HerdrTarget {
	tabId: string;
	paneId: string;
}

export interface HerdrDisplayAgent {
	name: string;
	conversationId: ConversationId;
	active: boolean;
	/** Durable acceptance order of this work period's first reporter, independent of registry order. */
	workOrder: number;
	workStart?: EntryId;
	workKey?: string;
}

export interface AgentServiceOptions {
	harness: Harness;
	root: Conversation;
	cwd: string;
	presets: PresetCatalog;
	modelRegistry: ModelRegistry;
	parentModel: ModelRef;
	parentThinking: ModelThinkingLevel;
	telemetry?: TelemetryContext;
	codemodeExtension?: Extension;
}

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } }): void {
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.totalTokens += usage.totalTokens ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

export function aggregateUsage(state: UsageState | undefined): UsageTotals {
	const totals = emptyUsage();
	if (state === undefined) return totals;
	for (const usage of Object.values(state.models)) addUsage(totals, usage);
	return totals;
}

export function orderStatsRows(rows: readonly StatsRow[]): StatsRow[] {
	return [...rows].sort((a, b) => b.usage.cost - a.usage.cost || a.name.localeCompare(b.name));
}

function ensureStateShape(state: SubagentsState): SubagentsState {
	state.agents ??= {};
	state.reports ??= {};
	return state;
}

/** Read submission state, not reporter liveness: a reporter can be preparing a report long after work ends.
 * Retain every input in a continuous work period, since several steers may settle with the same answer.
 * Called on the Session line so send and display polling cannot race period assignment.
 */
async function refreshWork(tx: Tx, agent: ManagedAgentRecord): Promise<boolean> {
	const live = await tx.doc(LiveDoc, agent.conversationId);
	const legacy = agent.workReporterTaskIds == null;
	const requests = await Promise.all((agent.workReporterTaskIds ?? agent.reporterTaskIds ?? []).map(async (taskId) => {
		const task = await tx.task(taskId);
		const requestId = task?.input !== null && typeof task?.input === "object"
			&& !Array.isArray(task.input) && typeof task.input.requestId === "string" ? task.input.requestId : undefined;
		const submission = requestId === undefined ? undefined : await tx.submissionByRequest(agent.conversationId, requestId);
		const active = submission === undefined
			? task !== undefined && !task.abortRequested && task.state.status !== "terminal" && task.state.status !== "completing"
			: submission.status === "queued" || submission.status === "placed";
		return { taskId, submission, active };
	}));
	const active = live.run !== undefined || requests.some((request) => request.active);
	if (legacy) {
		// Recover in-flight legacy work from its actual run boundary. For idle legacy agents, submissions
		// sharing the latest answer are the best available durable grouping (never use pending reports).
		const latest = requests.at(-1)?.submission;
		const relevant = active ? requests.filter((request) => request.active) : requests.filter(({ submission }) =>
			submission !== undefined && latest !== undefined && (submission.id === latest.id
				|| (latest.status === "done" && submission.status === "done" && submission.answer === latest.answer)),
		);
		agent.workReporterTaskIds = relevant.map(({ taskId }) => taskId);
		const identity = relevant[0]?.taskId ?? live.run?.first ?? live.run?.taskId;
		agent.workKey = identity === undefined ? null : `legacy:${identity}`;
		const entries = relevant.flatMap(({ submission }) => submission?.entry === undefined ? [] : [submission.entry]);
		if (live.run?.first !== undefined) entries.push(live.run.first);
		agent.workStart = entries.sort((a, b) => a - b)[0] ?? null;
	} else {
		const entries = requests.flatMap(({ submission }) => submission?.entry === undefined ? [] : [submission.entry]);
		if (agent.workStart != null) entries.push(agent.workStart);
		if (live.run?.first !== undefined) entries.push(live.run.first);
		const workStart = entries.sort((a, b) => a - b)[0] ?? null;
		if (agent.workStart !== workStart) agent.workStart = workStart;
	}
	return active;
}

function toolRegistrations(names: readonly string[] | undefined) {
	if (names === undefined) return undefined;
	const byName = new Map((CodingTools.tools ?? []).map((tool) => [tool.name, tool]));
	return names.map((name) => {
		const tool = byName.get(name);
		if (tool === undefined) throw new Error(`Durable coding tool "${name}" is unavailable.`);
		return tool;
	});
}

function messageFor(name: string, message: string): string {
	return `Task from the main Pi agent (${name}):\n\n${message}\n\nComplete the task and return a concise report to the main agent.`;
}

function choosePreset(catalog: PresetCatalog, requestedName: string | undefined, requestedPresetId: string | undefined): {
	preset?: AgentPreset;
	presetId: string | null;
	baseName: string;
} {
	const selectedId = requestedPresetId ?? (requestedName !== undefined && catalog.entries.has(requestedName) ? requestedName : undefined);
	const preset = getPresetOrFallback(catalog, selectedId);
	const baseName = requestedName ?? selectedId;
	if (baseName === undefined) throw new Error("Spawn needs a meaningful name, or a preset ID to use as its name.");
	return { preset, presetId: preset?.id ?? null, baseName: validateAgentName(baseName) };
}

function validateModelReference(registry: ModelRegistry, model: ModelRef, source: string): void {
	const resolved = registry.find(model.provider, model.modelId);
	if (resolved === undefined) {
		throw new Error(`${source} model "${model.provider}/${model.modelId}" is not present in Pi's model registry.`);
	}
	if (!registry.hasConfiguredAuth(resolved)) {
		throw new Error(`${source} model "${model.provider}/${model.modelId}" is unavailable with Pi's configured provider authentication.`);
	}
}

export class AgentService {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly cwd: string;
	readonly presets: PresetCatalog;
	readonly #modelRegistry: ModelRegistry;
	#parentModel: ModelRef;
	#parentThinking: ModelThinkingLevel;
	#telemetry?: TelemetryContext;
	#codemodeExtension?: Extension;
	#footerHistory = new Map<ConversationId, AgentHistoryCounts>();

	constructor(options: AgentServiceOptions) {
		this.harness = options.harness;
		this.root = options.root;
		this.cwd = options.cwd;
		this.presets = options.presets;
		this.#modelRegistry = options.modelRegistry;
		this.#parentModel = options.parentModel;
		this.#parentThinking = options.parentThinking;
		this.#telemetry = options.telemetry;
		this.#codemodeExtension = options.codemodeExtension;
	}

	async #state(): Promise<SubagentsState> {
		const snapshot = await this.harness.snapshot(SubagentsDoc, this.root.id, BACKGROUND_CONTEXT);
		return {
			agents: { ...(snapshot?.agents ?? {}) },
			reports: { ...(snapshot?.reports ?? {}) },
			herdrPaneCreationPending: snapshot?.herdrPaneCreationPending ?? false,
		};
	}

	async spawn(requestedName: string | undefined, requestedPresetId: string | undefined, message: string): Promise<SpawnResult> {
		const { preset, presetId, baseName } = choosePreset(this.presets, requestedName, requestedPresetId);
		const model = preset?.model ?? this.#parentModel;
		const thinkingLevel = preset?.thinking ?? this.#parentThinking;
		validateModelReference(this.#modelRegistry, model, preset?.model === undefined ? "Inherited" : `Preset "${preset.id}"`);
		let selectedTools: ToolRegistration[] | undefined = toolRegistrations(preset?.tools);
		let extensions: Extension[] = [CodingTools];
		if (preset?.codemode === true) {
			const codemodeTool = this.#codemodeExtension?.tools?.find((tool) => tool.name === "codemode");
			if (codemodeTool === undefined || this.#codemodeExtension === undefined) {
				throw new Error(`Preset "${preset.id}" enables Code Mode, but its runtime is unavailable.`);
			}
			selectedTools ??= [...(CodingTools.tools ?? [])];
			selectedTools = [...selectedTools, codemodeTool as ToolRegistration];
			extensions = [CodingTools, this.#codemodeExtension];
		}
		const operationId = randomUUID();

		return inTelemetrySpan(
			this.#telemetry,
			{
				name: "durable_subagents.request",
				attributes: {
					"managed_agent.operation": "spawn",
					"managed_agent.name": baseName,
					...cappedContentAttributes("managed_agent.task.text", message),
				},
			},
			(span) => {
				const context = span === undefined ? BACKGROUND_CONTEXT : withTelemetry(span, BACKGROUND_CONTEXT);
				return this.root.commit(async (tx) => {
					const state = ensureStateShape(await tx.doc(SubagentsDoc, this.root.id));
					const name = uniqueAgentName(baseName, state.agents);
					const anchorTaskId = await tx.createTask(AgentAnchor, null, {
						ownership: { kind: "conversation" },
						background: true,
					});
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchorTaskId } });
					await configure(tx, child.id, {
						extensions,
						model,
						thinkingLevel,
						instructions: `${preset?.instructions ?? ""}${preset === undefined ? "" : "\n\n"}You are the managed agent named "${name}". Follow the task from the main Pi agent and return a useful report.`,
						cwd: this.cwd,
						...(selectedTools === undefined ? {} : { tools: selectedTools, modelTools: selectedTools }),
					});

					const reporterInput = {
						agentName: name,
						conversationId: child.id,
						message: messageFor(name, message),
						taskText: message,
						requestId: `managed-agent:${operationId}`,
						reportId: operationId,
					};
					const reporterTaskId = await tx.createTask(AgentReporter, reporterInput, {
						ownership: { kind: "conversation" },
						background: true,
					});
					state.agents[name] = {
						conversationId: child.id,
						presetId,
						herdrTarget: null,
						herdrOutputVersion: null,
						inheritModel: preset?.model === undefined,
						inheritThinking: preset?.thinking === undefined,
						incomingCount: 1,
						outgoingCount: 0,
						latestTask: message,
						fresh: true,
						reporterTaskIds: [reporterTaskId],
						workReporterTaskIds: [reporterTaskId],
						workKey: operationId,
						workStart: null,
					};
					return { name, conversationId: child.id, reporterTaskId };
				}, context);
			},
		);
	}

	async send(name: string, message: string): Promise<MessageResult> {
		const agentName = validateAgentName(name);
		if (message.trim() === "") throw new Error("Send needs a non-empty message.");
		const operationId = randomUUID();

		return inTelemetrySpan(
			this.#telemetry,
			{
				name: "durable_subagents.request",
				attributes: {
					"managed_agent.operation": "send",
					"managed_agent.name": agentName,
					...cappedContentAttributes("managed_agent.task.text", message),
				},
			},
			(span) => {
				const context = span === undefined ? BACKGROUND_CONTEXT : withTelemetry(span, BACKGROUND_CONTEXT);
				return this.root.commit(async (tx) => {
					const state = ensureStateShape(await tx.doc(SubagentsDoc, this.root.id));
					const agent = Object.hasOwn(state.agents, agentName) ? state.agents[agentName] : undefined;
					if (agent === undefined) throw new Error(`No managed agent named "${agentName}".`);
					const continuing = await refreshWork(tx, agent);
					if (!continuing) {
						agent.workKey = operationId;
						agent.workStart = null;
						agent.workReporterTaskIds = [];
					}
					agent.incomingCount = (agent.incomingCount ?? 0) + 1;
					agent.latestTask = message;
					agent.fresh = false;
					agent.reporterTaskIds ??= [];
					const reporterTaskId = await tx.createTask(
						AgentReporter,
						{
							agentName,
							conversationId: agent.conversationId,
							message: messageFor(agentName, message),
							taskText: message,
							requestId: `managed-agent:${operationId}`,
							reportId: operationId,
						},
						{ ownership: { kind: "conversation" }, background: true },
					);
					agent.reporterTaskIds.push(reporterTaskId);
					agent.workReporterTaskIds!.push(reporterTaskId);
					return { reporterTaskId, requestId: `managed-agent:${operationId}`, conversationId: agent.conversationId };
				}, context);
			},
		);
	}

	async list(): Promise<AgentSummary[]> {
		const state = await this.#state();
		const summaries: AgentSummary[] = [];
		for (const [name, agent] of Object.entries(state.agents)) {
			const live = await this.harness.snapshot(LiveDoc, agent.conversationId, BACKGROUND_CONTEXT);
			const usage = await this.harness.snapshot(UsageDoc, agent.conversationId, BACKGROUND_CONTEXT);
			summaries.push({
				name,
				conversationId: agent.conversationId,
				active: live?.run !== undefined,
				presetId: agent.presetId ?? null,
				incomingCount: agent.incomingCount ?? 0,
				outgoingCount: agent.outgoingCount ?? 0,
				usage: aggregateUsage(usage),
			});
		}
		return summaries.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
	}

	async footerSummaries(includeIdle = false): Promise<AgentFooterSummary[]> {
		const state = await this.#state();
		const records = (await Promise.all(
			Object.entries(state.agents).map(async ([name, record]) => {
				const active = (await this.harness.snapshot(LiveDoc, record.conversationId, BACKGROUND_CONTEXT))?.run !== undefined;
				const queued = !active && await this.#hasPendingReporter(record);
				return { name, record, active, queued };
			}),
		)).filter(({ active, queued }) => includeIdle || active || queued);
		const summaries = await Promise.all(
			records.map(async ({ name, record, active, queued }) => {
				const [usageState, conversation] = await Promise.all([
					this.harness.snapshot(UsageDoc, record.conversationId, BACKGROUND_CONTEXT),
					this.harness.conversation(record.conversationId, BACKGROUND_CONTEXT),
				]);
				if (conversation === undefined) return undefined;
				const [agent, history] = await Promise.all([
					conversation.agent(BACKGROUND_CONTEXT),
					this.#historyCounts(conversation, record.conversationId),
				]);
				const model = agent.model === undefined
					? undefined
					: this.#modelRegistry.find(agent.model.provider, agent.model.modelId);

				return {
					name,
					conversationId: record.conversationId,
					active,
					queued,
					presetId: record.presetId ?? null,
					incomingCount: record.incomingCount ?? 0,
					outgoingCount: record.outgoingCount ?? 0,
					usage: aggregateUsage(usageState),
					modelLabel: agent.model?.modelId ?? "no-model",
					thinkingLevel: agent.thinkingLevel,
					turns: history.turns,
					toolUses: history.toolUses,
					contextTokens: history.contextTokens,
					contextWindow: model?.contextWindow ?? null,
					latestTask: record.latestTask ?? "",
					fresh: record.fresh === true,
				};
			}),
		);
		return summaries
			.filter((summary): summary is AgentFooterSummary => summary !== undefined)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async #hasPendingReporter(record: ManagedAgentRecord): Promise<boolean> {
		for (const taskId of record.reporterTaskIds ?? []) {
			const task = await this.harness.getTask(taskId, BACKGROUND_CONTEXT);
			if (task !== undefined && task.state.status !== "terminal") return true;
		}
		return false;
	}

	async #historyCounts(conversation: Conversation, conversationId: ConversationId): Promise<AgentHistoryCounts> {
		const counts = this.#footerHistory.get(conversationId) ?? { turns: 0, toolUses: 0, contextTokens: null };
		const lastEntryId = counts.lastEntryId;
		const query = lastEntryId === undefined
			? { order: "ascending" as const }
			: { order: "ascending" as const, minEntryId: lastEntryId };
		let cursor: Cursor | undefined;
		let firstPage = true;
		do {
			const page = await conversation.entries(query, HISTORY_PAGE_SIZE, cursor, BACKGROUND_CONTEXT);
			for (const entry of page.items) {
				if (firstPage && entry.id === lastEntryId) continue;
				if (AssistantEntry.is(entry)) {
					counts.turns++;
					const message = entry.model?.[0];
					if (isAssistantMessage(message)) {
						counts.contextTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
					}
				} else if (ToolResultEntry.is(entry)) {
					const message = entry.model?.[0];
					const didNotExecute = entry.data.diagnostics.some((diagnostic) =>
						diagnostic.code !== undefined && NON_EXECUTED_TOOL_DIAGNOSTICS.has(diagnostic.code),
					);
					if (message?.role === "toolResult" && !didNotExecute) {
						counts.toolUses += 1 + (message.nestedCalls?.calls.length ?? 0);
					}
				}
				counts.lastEntryId = entry.id;
			}
			firstPage = false;
			cursor = page.next;
		} while (cursor !== undefined);
		this.#footerHistory.set(conversationId, counts);
		return counts;
	}

	/** Persisted fail-safe for a split whose target may not yet be durably associated. Never clears itself. */
	async herdrPaneCreationPending(): Promise<boolean> {
		return (await this.#state()).herdrPaneCreationPending === true;
	}

	async setHerdrPaneCreationPending(pending: boolean): Promise<void> {
		await this.root.commit(async (tx) => {
			const state = ensureStateShape(await tx.doc(SubagentsDoc, this.root.id));
			if (state.herdrPaneCreationPending !== pending) state.herdrPaneCreationPending = pending;
		}, BACKGROUND_CONTEXT);
	}

	async herdrTarget(name: string): Promise<HerdrTarget | undefined> {
		const state = await this.#state();
		const target = state.agents[validateAgentName(name)]?.herdrTarget;
		return target == null ? undefined : { ...target };
	}

	async herdrAgents(): Promise<Array<{ name: string; conversationId: ConversationId }>> {
		const state = await this.#state();
		return Object.entries(state.agents)
			.filter(([, agent]) => agent.herdrTarget != null)
			.map(([name, agent]) => ({ name, conversationId: agent.conversationId }));
	}

	/** All registered agents, whether or not they have ever owned a display pane. */
	async herdrDisplayAgents(): Promise<HerdrDisplayAgent[]> {
		return this.root.commit(async (tx) => {
			const state = ensureStateShape(await tx.doc(SubagentsDoc, this.root.id));
			const summaries: HerdrDisplayAgent[] = [];
			for (const [name, agent] of Object.entries(state.agents)) {
				const active = await refreshWork(tx, agent);
				summaries.push({ name, conversationId: agent.conversationId, active,
					workOrder: agent.workReporterTaskIds?.[0] ?? agent.reporterTaskIds?.at(-1) ?? agent.conversationId,
					...(agent.workStart == null ? {} : { workStart: agent.workStart }),
					...(agent.workKey == null ? {} : { workKey: agent.workKey }),
				});
			}
			return summaries;
		}, BACKGROUND_CONTEXT);
	}

	async setHerdrTarget(name: string, target: HerdrTarget | undefined, completePaneCreation = false): Promise<void> {
		const agentName = validateAgentName(name);
		await this.root.commit(async (tx) => {
			const state = ensureStateShape(await tx.doc(SubagentsDoc, this.root.id));
			const agent = Object.hasOwn(state.agents, agentName) ? state.agents[agentName] : undefined;
			if (agent === undefined) throw new Error(`No managed agent named "${agentName}".`);
			if (target === undefined) {
				if (agent.herdrTarget !== null) agent.herdrTarget = null;
				if (agent.herdrOutputVersion !== null) agent.herdrOutputVersion = null;
			} else {
				if (agent.herdrTarget?.tabId !== target.tabId || agent.herdrTarget?.paneId !== target.paneId) {
					agent.herdrTarget = { tabId: target.tabId, paneId: target.paneId };
					agent.herdrOutputVersion = null;
				}
				// Complete the reservation atomically with the durable association, never before it.
				if (completePaneCreation && state.herdrPaneCreationPending !== false) state.herdrPaneCreationPending = false;
			}
		}, BACKGROUND_CONTEXT);
	}

	async herdrOutputVersion(name: string): Promise<number | undefined> {
		const state = await this.#state();
		return state.agents[validateAgentName(name)]?.herdrOutputVersion ?? undefined;
	}

	async setHerdrOutputVersion(name: string, version: number): Promise<void> {
		const agentName = validateAgentName(name);
		await this.root.commit(async (tx) => {
			const state = ensureStateShape(await tx.doc(SubagentsDoc, this.root.id));
			const agent = Object.hasOwn(state.agents, agentName) ? state.agents[agentName] : undefined;
			if (agent === undefined) throw new Error(`No managed agent named "${agentName}".`);
			agent.herdrOutputVersion = version;
		}, BACKGROUND_CONTEXT);
	}

	async status(name: string): Promise<AgentSummary> {
		const agentName = validateAgentName(name);
		const found = (await this.list()).find((agent) => agent.name === agentName);
		if (found === undefined) throw new Error(`No managed agent named "${agentName}".`);
		return found;
	}

	async stop(name: string): Promise<void> {
		const agentName = validateAgentName(name);
		const state = await this.#state();
		const agent = Object.hasOwn(state.agents, agentName) ? state.agents[agentName] : undefined;
		if (agent === undefined) throw new Error(`No managed agent named "${agentName}".`);

		for (const taskId of agent.reporterTaskIds ?? []) {
			const task = await this.harness.getTask(taskId, BACKGROUND_CONTEXT);
			if (task !== undefined && task.state.status !== "terminal") await this.harness.abortTask(taskId, BACKGROUND_CONTEXT);
		}
		const child = await this.harness.conversation(agent.conversationId, BACKGROUND_CONTEXT);
		await child?.abort(BACKGROUND_CONTEXT);
	}

	async stopAll(): Promise<string[]> {
		const state = await this.#state();
		const active: string[] = [];
		for (const [name, agent] of Object.entries(state.agents)) {
			const live = await this.harness.snapshot(LiveDoc, agent.conversationId, BACKGROUND_CONTEXT);
			let hasPendingRequest = false;
			for (const taskId of agent.reporterTaskIds ?? []) {
				const task = await this.harness.getTask(taskId, BACKGROUND_CONTEXT);
				if (task !== undefined && task.state.status !== "terminal") {
					hasPendingRequest = true;
					break;
				}
			}
			if (live?.run !== undefined || hasPendingRequest) active.push(name);
		}
		for (const name of active) await this.stop(name);
		return active;
	}

	async markReportDelivered(reportId: string): Promise<void> {
		await this.root.commit(async (tx) => {
			const state = ensureStateShape(await tx.doc(SubagentsDoc, this.root.id));
			const report = Object.hasOwn(state.reports, reportId) ? state.reports[reportId] : undefined;
			if (report === undefined || report.delivered === true) return;
			report.delivered = true;
			const agent = Object.hasOwn(state.agents, report.agentName) ? state.agents[report.agentName] : undefined;
			if (agent !== undefined) agent.outgoingCount = (agent.outgoingCount ?? 0) + 1;
		}, BACKGROUND_CONTEXT);
	}

	async pendingReports(): Promise<ManagedReportRecord[]> {
		const state = await this.#state();
		return Object.values(state.reports).filter((report) => report.delivered !== true);
	}

	async stats(): Promise<{ total: UsageTotals; rows: StatsRow[] }> {
		const agents = await this.list();
		const rows = orderStatsRows(agents.map(({ name, usage }) => ({ name, usage })));
		const total = emptyUsage();
		for (const row of rows) {
			total.input += row.usage.input;
			total.output += row.usage.output;
			total.cacheRead += row.usage.cacheRead;
			total.cacheWrite += row.usage.cacheWrite;
			total.totalTokens += row.usage.totalTokens;
			total.cost += row.usage.cost;
		}
		return { total, rows };
	}

	async updateInherited(parentModel: ModelRef, parentThinking: ModelThinkingLevel): Promise<void> {
		this.#parentModel = parentModel;
		this.#parentThinking = parentThinking;
		await this.root.configure({ model: parentModel, thinkingLevel: parentThinking }, BACKGROUND_CONTEXT);
		const state = await this.#state();
		for (const agent of Object.values(state.agents)) {
			const change = {
				...(agent.inheritModel !== false ? { model: parentModel } : {}),
				...(agent.inheritThinking !== false ? { thinkingLevel: parentThinking } : {}),
			};
			if (Object.keys(change).length === 0) continue;
			const child = await this.harness.conversation(agent.conversationId, BACKGROUND_CONTEXT);
			await child?.configure(change, BACKGROUND_CONTEXT);
		}
	}
}

/** Useful for callers that inspect durable report metadata without exposing mutable document drafts. */
export function isManagedReport(value: unknown): value is ManagedReportRecord {
	return value !== null && typeof value === "object" && typeof (value as ManagedReportRecord).id === "string";
}

export function isAssistantMessage(value: unknown): value is AssistantMessage {
	return value !== null && typeof value === "object" && (value as AssistantMessage).role === "assistant";
}
