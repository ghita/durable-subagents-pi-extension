import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry, UserEntry, type AgentState, type ConversationId, type ConversationView, type ConversationWatch, type EntryId, type Harness, type ModelRef, type Conversation, type Cursor } from "@earendil-works/pi-durable";
import type { AgentService, HerdrTarget } from "./agent-service.ts";

const execFileAsync = promisify(execFile);
const HERDR_SOURCE = "pi-durable-subagents";
const HERDR_AGENT = "pi";
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const HERDR_OUTPUT_VERSION = 1;
const HERDR_RENDERER_PATH = fileURLToPath(new URL("./herdr-pane-renderer.cjs", import.meta.url));
const RENDERER_START_TIMEOUT_MS = 5_000;
const RENDERER_REQUEST_TIMEOUT_MS = 5_000;

export interface HerdrMetadata {
	displayAgent: string;
	title: string;
	tokens: Record<string, string>;
}

export type HerdrSplitDirection = "right" | "down";

export interface HerdrPaneGeometry {
	paneId: string;
	rect: { x: number; y: number; width: number; height: number };
}

export interface HerdrApi {
	createPane(cwd: string, label: string, anchorPaneId?: string, direction?: HerdrSplitDirection): Promise<HerdrTarget>;
	getPane(paneId: string): Promise<HerdrTarget>;
	movePane(paneId: string, tabId: string, anchorPaneId: string, label: string, direction: HerdrSplitDirection): Promise<HerdrTarget>;
	paneLayout(paneId: string): Promise<HerdrPaneGeometry[]>;
	resizePane(paneId: string, direction: "up" | "down", amount: number): Promise<void>;
	reportMetadata(paneId: string, metadata: HerdrMetadata): Promise<void>;
	appendText(paneId: string, text: string): Promise<void>;
	resetText(paneId: string): Promise<void>;
	closePane(paneId: string): Promise<void>;
}

/** Only positive evidence of absence permits a replacement split. Transport errors do not. */
export class HerdrPaneMissingError extends Error {}

/** The CLI process could not start, so no external split could have happened. */
export class HerdrPaneCreationRejectedError extends Error {}

export type HerdrCommandRunner = (args: readonly string[]) => Promise<string>;

function defaultHerdrCommand(args: readonly string[]): Promise<string> {
	return execFileAsync("herdr", [...args], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: 5_000,
		windowsHide: true,
	}).then(({ stdout }) => stdout);
}

function apiResult(output: string): Record<string, any> {
	const response = JSON.parse(output) as { result?: unknown };
	const result = response?.result ?? response;
	if (result === null || typeof result !== "object" || Array.isArray(result)) {
		throw new Error("Herdr returned an invalid API response.");
	}
	return result as Record<string, any>;
}

function rendererSocketPath(paneId: string): string {
	const workspaceId = process.env.HERDR_WORKSPACE_ID ?? "local";
	const herdrSocketPath = process.env.HERDR_SOCKET_PATH ?? "local";
	const suffix = createHash("sha256").update(`${herdrSocketPath}\0${workspaceId}\0${paneId}`).digest("hex").slice(0, 24);
	return process.platform === "win32"
		? `\\\\.\\pipe\\durable-subagents-${suffix}`
		: join(tmpdir(), `dsa-${suffix}.sock`);
}

function rendererRequest(
	socketPath: string,
	request: { type: "ping" | "reset"; id: string } | { type: "append"; id: string; text: string },
	timeoutMs = RENDERER_REQUEST_TIMEOUT_MS,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let settled = false;
		let responseBuffer = "";
		const timeout = setTimeout(() => finish(new Error("Timed out waiting for Herdr pane renderer.")), timeoutMs);

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			if (error === undefined) resolve();
			else reject(error);
		};

		socket.setEncoding("utf8");
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`, (error) => {
				if (error !== undefined && error !== null) finish(error);
			});
		});
		socket.on("data", (chunk: string) => {
			responseBuffer += chunk;
			const newline = responseBuffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const response = JSON.parse(responseBuffer.slice(0, newline)) as { id?: unknown; ok?: unknown; error?: unknown };
				if (response.id !== request.id || response.ok !== true) {
					finish(new Error(typeof response.error === "string" ? response.error : "Herdr pane renderer rejected the update."));
					return;
				}
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error("Invalid response from Herdr pane renderer."));
			}
		});
		socket.once("error", (error) => finish(error));
		socket.once("end", () => {
			if (!settled) finish(new Error("Herdr pane renderer closed the connection without acknowledging the update."));
		});
	});
}

/** Herdr's CLI handles pane management; a persistent pane-side process renders transcript text over local IPC. */
export class HerdrCliApi implements HerdrApi {
	readonly #run: HerdrCommandRunner;
	readonly #currentTabId?: string;
	readonly #appendTails = new Map<string, Promise<void>>();

	constructor(run: HerdrCommandRunner = defaultHerdrCommand, currentTabId = process.env.HERDR_TAB_ID) {
		this.#run = run;
		this.#currentTabId = currentTabId;
	}

	#paneTarget(output: string): HerdrTarget {
		const pane = apiResult(output).pane;
		const paneId = pane?.pane_id;
		const tabId = pane?.tab_id ?? this.#currentTabId;
		if (typeof tabId !== "string" || typeof paneId !== "string") {
			throw new Error("Herdr did not return the pane and tab IDs.");
		}
		return { tabId, paneId };
	}

	async createPane(cwd: string, label: string, anchorPaneId?: string, direction: HerdrSplitDirection = "right"): Promise<HerdrTarget> {
		const args = anchorPaneId === undefined
			? ["pane", "split", "--current", "--direction", direction, "--no-focus", "--cwd", cwd]
			: ["pane", "split", anchorPaneId, "--direction", direction, "--no-focus", "--cwd", cwd];
		let output: string;
		try {
			output = await this.#run(args);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT" || code === "EACCES") {
				throw new HerdrPaneCreationRejectedError("The Herdr CLI could not start; no pane was created.", { cause: error });
			}
			throw error;
		}
		const target = this.#paneTarget(output);
		try {
			await this.#run(["pane", "rename", target.paneId, label]);
		} catch {
			// The pane still works if Herdr cannot apply the display label.
		}
		return target;
	}

	async getPane(paneId: string): Promise<HerdrTarget> {
		try {
			return this.#paneTarget(await this.#run(["pane", "get", paneId]));
		} catch (error) {
			// A failed get may mean an unavailable server rather than a closed pane. Only a
			// successful, explicit workspace inventory can distinguish those cases safely.
			const workspace = process.env.HERDR_WORKSPACE_ID;
			if (workspace !== undefined) {
				try {
					const panes = apiResult(await this.#run(["pane", "list", "--workspace", workspace])).panes;
					if (Array.isArray(panes) && panes.every((pane: any) => typeof pane?.pane_id === "string")
						&& !panes.some((pane: any) => pane.pane_id === paneId)) {
						throw new HerdrPaneMissingError(`Herdr pane ${paneId} no longer exists.`);
					}
				} catch (inventoryError) {
					if (inventoryError instanceof HerdrPaneMissingError) throw inventoryError;
				}
			}
			throw error;
		}
	}

	async closePane(paneId: string): Promise<void> {
		await this.#run(["pane", "close", paneId]);
	}

	async movePane(paneId: string, tabId: string, anchorPaneId: string, label: string, direction: HerdrSplitDirection): Promise<HerdrTarget> {
		const moved = this.#paneTarget(await this.#run([
			"pane", "move", paneId, "--tab", tabId, "--split", direction,
			"--target-pane", anchorPaneId, "--no-focus",
		]));
		try {
			await this.#run(["pane", "rename", moved.paneId, label]);
		} catch {
			// The pane still works if Herdr cannot apply the display label.
		}
		return moved;
	}

	async paneLayout(paneId: string): Promise<HerdrPaneGeometry[]> {
		const layout = apiResult(await this.#run(["pane", "layout", "--pane", paneId])).layout;
		if (layout === null || typeof layout !== "object" || !Array.isArray(layout.panes)) {
			throw new Error("Herdr did not return pane layout geometry.");
		}
		return layout.panes.flatMap((pane: any) => {
			const rect = pane?.rect;
			if (typeof pane?.pane_id !== "string" || rect === null || typeof rect !== "object") return [];
			if (![rect.x, rect.y, rect.width, rect.height].every((value) => typeof value === "number" && Number.isFinite(value))) return [];
			return [{ paneId: pane.pane_id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
		});
	}

	async resizePane(paneId: string, direction: "up" | "down", amount: number): Promise<void> {
		if (!Number.isFinite(amount) || amount <= 0) return;
		await this.#run(["pane", "resize", "--direction", direction, "--amount", String(amount), "--pane", paneId]);
	}

	async reportMetadata(paneId: string, metadata: HerdrMetadata): Promise<void> {
		const args = [
			"pane", "report-metadata", paneId,
			"--source", HERDR_SOURCE,
			"--agent", HERDR_AGENT,
			"--display-agent", metadata.displayAgent,
			"--title", metadata.title,
			"--ttl-ms", String(METADATA_TTL_MS),
		];
		for (const [name, value] of Object.entries(metadata.tokens)) args.push("--token", `${name}=${value}`);
		await this.#run(args);
		try {
			await this.#run(["pane", "rename", paneId, metadata.displayAgent]);
		} catch {
			// Identity is also shown by metadata and the terminal header.
		}
	}

	appendText(paneId: string, text: string): Promise<void> {
		return this.#queueOutput(paneId, text);
	}

	resetText(paneId: string): Promise<void> {
		return this.#queueOutput(paneId);
	}

	async #queueOutput(paneId: string, text?: string): Promise<void> {
		const previous = this.#appendTails.get(paneId) ?? Promise.resolve();
		const queued = previous.catch(() => undefined).then(() => this.#appendTextNow(paneId, text));
		this.#appendTails.set(paneId, queued);
		try {
			await queued;
		} finally {
			if (this.#appendTails.get(paneId) === queued) this.#appendTails.delete(paneId);
		}
	}

	async #appendTextNow(paneId: string, text?: string): Promise<void> {
		// Bootstrap the renderer once per pane; subsequent transcript updates use its local socket.
		const socketPath = rendererSocketPath(paneId);
		await this.#ensureRenderer(paneId, socketPath);
		if (text === undefined) {
			try {
				await rendererRequest(socketPath, { type: "reset", id: randomUUID() });
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "invalid append message") throw error;
				// An already-running pre-slot renderer only understands append. Clear
				// through that protocol rather than starting a second process in its pane.
				await rendererRequest(socketPath, { type: "append", id: randomUUID(), text: "\u001b[3J\u001b[2J\u001b[H" });
			}
		} else {
			const contents = text.endsWith("\n") ? text : `${text}\n`;
			await rendererRequest(socketPath, { type: "append", id: randomUUID(), text: contents });
		}
	}

	async #ensureRenderer(paneId: string, socketPath: string): Promise<void> {
		try {
			await rendererRequest(socketPath, { type: "ping", id: randomUUID() }, 500);
			return;
		} catch {
			// The pane has not started its persistent output process yet.
		}

		const scriptPath = Buffer.from(HERDR_RENDERER_PATH, "utf8").toString("base64");
		const encodedSocketPath = Buffer.from(socketPath, "utf8").toString("base64");
		const command = `node -e "require('node:child_process').spawnSync(process.execPath,[Buffer.from('${scriptPath}','base64').toString('utf8'),Buffer.from('${encodedSocketPath}','base64').toString('utf8')],{stdio:'inherit'})"`;
		await this.#run(["pane", "run", paneId, command]);

		const deadline = Date.now() + RENDERER_START_TIMEOUT_MS;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				await rendererRequest(socketPath, { type: "ping", id: randomUUID() }, RENDERER_REQUEST_TIMEOUT_MS);
				return;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		throw new Error(`Herdr pane renderer did not start for pane ${paneId}.`, { cause: lastError });
	}
}

export function herdrApiFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	run?: HerdrCommandRunner,
): { api: HerdrApi; currentPane?: HerdrTarget } | undefined {
	const workspaceId = environment.HERDR_WORKSPACE_ID;
	if (environment.HERDR_ENV !== "1" || workspaceId === undefined || workspaceId.length === 0) return undefined;
	const tabId = environment.HERDR_TAB_ID;
	const paneId = environment.HERDR_PANE_ID;
	return {
		api: new HerdrCliApi(run, tabId),
		...(tabId === undefined || paneId === undefined ? {} : { currentPane: { tabId, paneId } }),
	};
}

const TOOL_ARGUMENT_LIMIT = 500;

type AgentIdentity = { model?: ModelRef; thinking: string };

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function cleanText(text: string, limit = 240): string {
	const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s{2,}/g, " ");
	return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

/** Keep readable line breaks while removing terminal control characters from conversation content. */
function cleanTerminalText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function modelLabel(model: ModelRef | undefined): string {
	return model === undefined ? "no-model" : cleanText(`${model.provider}/${model.modelId}`, 120);
}

function identityFromView(view: ConversationView, fallback: AgentIdentity): AgentIdentity {
	const agent = view.docs["pi.agent"] as AgentState | undefined;
	return {
		model: agent?.model ?? fallback.model,
		thinking: stringValue(agent?.thinkingLevel) ?? fallback.thinking,
	};
}

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

export function herdrMetadataForAgent(name: string, model: ModelRef | undefined, thinking: string): HerdrMetadata {
	const displayAgent = cleanText(name, 100);
	const label = modelLabel(model);
	const level = cleanText(thinking, 32);
	return {
		displayAgent,
		title: cleanText(`${displayAgent} · ${label} · thinking ${level}`, 240),
		tokens: { model: label, thinking: level },
	};
}

export function herdrHeaderText(name: string, model: ModelRef | undefined, thinking: string): string {
	return [
		`Durable agent: ${cleanText(name, 100)}`,
		`Model: ${modelLabel(model)}`,
		`Thinking: ${cleanText(thinking, 32)}`,
	].join("\n");
}

function userInputText(message: UserMessage | undefined): string {
	if (message?.role !== "user") return "";
	const content = typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	return cleanTerminalText(content);
}

function assistantResponseText(message: AssistantMessage | undefined): string {
	if (message?.role !== "assistant") return "";
	return cleanTerminalText(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
}

function truncatedArguments(args: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(args) ?? "{}";
	} catch {
		serialized = "{}";
	}
	serialized = cleanTerminalText(serialized).replace(/\s+/g, " ");
	return serialized.length > TOOL_ARGUMENT_LIMIT
		? `${serialized.slice(0, TOOL_ARGUMENT_LIMIT - 1)}…`
		: serialized;
}

function recordToolCalls(entries: ConversationView["entries"], calls: Map<string, ToolCall>): void {
	for (const entry of entries) {
		if (!AssistantEntry.is(entry)) continue;
		const message = entry.model?.[0] as AssistantMessage | undefined;
		for (const part of message?.content ?? []) {
			if (part.type === "toolCall") calls.set(part.id, part);
		}
	}
}

function appendEntryLine(entry: ConversationView["entries"][number], calls: Map<string, ToolCall>): string | undefined {
	if (UserEntry.is(entry)) {
		const message = entry.model?.[0] as UserMessage | undefined;
		const text = userInputText(message);
		return text.trim() === "" ? undefined : `[user input]\n${text}`;
	}
	if (AssistantEntry.is(entry)) {
		const message = entry.model?.[0] as AssistantMessage | undefined;
		const text = assistantResponseText(message);
		return text.trim() === "" ? undefined : `[assistant]\n${text}`;
	}
	if (ToolResultEntry.is(entry)) {
		const result = entry.model?.[0] as ToolResultMessage | undefined;
		if (result?.role !== "toolResult") return undefined;
		const call = calls.get(result.toolCallId);
		const name = cleanText(call?.name ?? result.toolName, 100);
		const args = truncatedArguments(call?.arguments ?? {});
		calls.delete(result.toolCallId);
		return `[tool] ${name} ${args} — ${result.isError ? "failed" : "finished"}`;
	}
	return undefined;
}

function latestEntryId(view: ConversationView): EntryId | undefined {
	return view.entries.at(-1)?.id ?? view.before;
}

type WatchedAgent = {
	name: string;
	conversationId: ConversationId;
	conversation: Conversation;
	watch: ConversationWatch;
	view: ConversationView;
	identity: AgentIdentity;
	active: boolean;
	observed?: boolean;
	order: number;
	idleSince: number;
	workStart?: EntryId;
	workKey?: string;
};

type DisplaySlot = {
	target: HerdrTarget;
	agent: WatchedAgent;
	assignedAt: number;
	relocate: boolean;
	headerWritten: boolean;
	lastEntryId?: EntryId;
	identity: AgentIdentity;
	toolCalls: Map<string, ToolCall>;
	lastMetadata?: string;
	reset: boolean;
	awaitingReplay: boolean;
	needsPersistence?: boolean;
	restoreCalls?: boolean;
	/** The previous work period ended between polls; this occupant must compete again. */
	yielding?: boolean;
};

export interface HerdrAgentMonitorOptions {
	api: HerdrApi;
	currentPane?: HerdrTarget;
	cwd: string;
	harness: Harness;
	service: AgentService;
	paneLimit?: number;
	onError?: (error: unknown, agentName: string) => void;
}

/** A serialized display scheduler. Agent lifetime is independent of the bounded pane slots. */
export class HerdrAgentMonitor {
	readonly #api: HerdrApi;
	readonly #currentPane?: HerdrTarget;
	readonly #cwd: string;
	readonly #harness: Harness;
	readonly #service: AgentService;
	readonly #onError: (error: unknown, agentName: string) => void;
	readonly #agents = new Map<string, WatchedAgent>();
	readonly #slots: DisplaySlot[] = [];
	readonly #errors = new Map<string, number>();
	#tail: Promise<void> = Promise.resolve();
	#refreshPending?: Promise<void>;
	#paneLimit: number;
	#clock = 0;
	#closed = false;
	// If split's outcome is unknown, it may have created an unaddressable pane. Do
	// not retry it (or other splits) and turn a transport outage into pane growth.
	#creationUncertain = false;
	#creationChecked = false;
	#layoutDirty = false;

	constructor(options: HerdrAgentMonitorOptions) {
		this.#api = options.api;
		this.#currentPane = options.currentPane;
		this.#cwd = options.cwd;
		this.#harness = options.harness;
		this.#service = options.service;
		this.#paneLimit = options.paneLimit ?? 3;
		this.#validateLimit(this.#paneLimit);
		this.#onError = options.onError ?? ((error, name) => console.error(`[durable-subagents] Herdr update failed for ${name}:`, error));
	}

	get paneLimit(): number { return this.#paneLimit; }

	#validateLimit(value: number): void {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Pane limit must be a nonnegative safe integer.");
	}

	#error(error: unknown, name: string): void {
		const key = `${name}:${error instanceof Error ? error.message : String(error)}`;
		const now = Date.now();
		if (now - (this.#errors.get(key) ?? -Infinity) < 30_000) return;
		this.#errors.set(key, now);
		// Diagnostics are optional too: a UI callback must never poison the scheduler.
		try { this.#onError(error, name); } catch { /* fail open */ }
	}

	#enqueue(action: () => Promise<void>): Promise<void> {
		if (this.#closed) return Promise.resolve();
		const next = this.#tail.then(async () => {
			if (!this.#closed) await action();
		});
		this.#tail = next.catch((error) => this.#error(error, "display"));
		return this.#tail;
	}

	setPaneLimit(value: number): Promise<void> {
		this.#validateLimit(value);
		return this.#enqueue(async () => {
			this.#paneLimit = value;
			await this.#refresh();
		});
	}

	refresh(): Promise<void> {
		// Polls/root-document notifications may arrive faster than CLI calls finish.
		// Coalesce them instead of allowing an unbounded scheduler backlog.
		if (this.#refreshPending !== undefined) return this.#refreshPending;
		const pending = this.#enqueue(() => this.#refresh());
		this.#refreshPending = pending;
		void pending.finally(() => {
			if (this.#refreshPending === pending) this.#refreshPending = undefined;
		});
		return pending;
	}

	async trackAgent(_name: string, _conversationId: ConversationId): Promise<void> {
		await this.refresh();
	}

	async attachPersistedAgents(): Promise<void> {
		await this.refresh();
	}

	#placement(exclude?: DisplaySlot): { anchorPaneId?: string; direction: HerdrSplitDirection } {
		const last = this.#slots.filter((slot) => slot !== exclude).at(-1);
		return last !== undefined
			? { anchorPaneId: last.target.paneId, direction: "down" }
			: { anchorPaneId: this.#currentPane?.paneId, direction: "right" };
	}

	async #addAgent(name: string, conversationId: ConversationId): Promise<WatchedAgent> {
		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error(`Managed agent "${name}" has no conversation.`);
		const [configured, stored, version] = await Promise.all([
			conversation.agent(BACKGROUND_CONTEXT),
			this.#service.herdrTarget(name),
			this.#service.herdrOutputVersion(name),
		]);
		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		const identity = identityFromView(watch.value, { model: configured.model, thinking: configured.thinkingLevel });
		const agent: WatchedAgent = {
			name, conversationId, conversation, watch, view: watch.value, identity,
			active: false, order: ++this.#clock, idleSince: this.#clock,
		};
		this.#agents.set(name, agent);
		if (stored !== undefined) {
			if (stored.paneId === this.#currentPane?.paneId) {
				// Never allow corrupt/stale association data to turn the main pane into a slot.
				try { await this.#service.setHerdrTarget(name, undefined); }
				catch (error) { this.#error(error, name); }
			} else if (!this.#slots.some((slot) => slot.target.paneId === stored.paneId)) {
				this.#layoutDirty = true;
				this.#slots.push({
					target: stored, agent, assignedAt: ++this.#clock, relocate: true,
					headerWritten: version === HERDR_OUTPUT_VERSION,
					lastEntryId: latestEntryId(watch.value), identity,
					toolCalls: new Map(), reset: version !== HERDR_OUTPUT_VERSION, awaitingReplay: version !== HERDR_OUTPUT_VERSION,
					restoreCalls: version === HERDR_OUTPUT_VERSION,
				});
			} else {
				// A crash during handoff can leave two associations to the same pane.
				// Count it once; the inactive duplicate can safely re-enter assignment.
				try { await this.#service.setHerdrTarget(name, undefined); }
				catch (error) { this.#error(error, name); }
			}
		}
		watch.start(async (call) => {
			if (call.kind !== "value" || this.#closed) return;
			// Keep the newest view without blocking the Durable watch on slow pane I/O.
			agent.view = call.value;
			void this.refresh();
		});
		return agent;
	}

	async #refresh(): Promise<void> {
		if (!this.#creationChecked) {
			this.#creationUncertain = await this.#service.herdrPaneCreationPending();
			this.#creationChecked = true;
			if (this.#creationUncertain) this.#error(new Error("A previous Herdr split has an unresolved outcome; new panes are suspended to prevent duplicates. Agent work continues."), "display");
		}
		const summaries = await this.#service.herdrDisplayAgents();
		let importFailed = false;
		// Import ALL persisted targets before any allocation so legacy excess panes
		// are included in the budget even if their agent is idle.
		for (const summary of summaries) {
			let agent = this.#agents.get(summary.name);
			if (agent === undefined) {
				try { agent = await this.#addAgent(summary.name, summary.conversationId); }
				catch (error) { importFailed = true; this.#error(error, summary.name); continue; }
			}
			const newPeriod = summary.workKey !== undefined && agent.workKey !== undefined && summary.workKey !== agent.workKey;
			if (summary.active && agent.observed && (!agent.active || newPeriod)) {
				// A retained idle display has no priority over already waiting work.
				// Work-period identity also catches idle intervals missed between polls.
				const slot = this.#slots.find((candidate) => candidate.agent === agent);
				if (slot !== undefined) slot.yielding = true;
				agent.idleSince = ++this.#clock;
			}
			if (summary.active && (!agent.active || newPeriod)) {
				agent.order = summary.workOrder ?? ++this.#clock;
			} else if (!summary.active && agent.active) {
				agent.idleSince = ++this.#clock;
			}
			agent.active = summary.active;
			agent.observed = true;
			agent.workStart = summary.workStart;
			agent.workKey = summary.workKey;
		}

		// Confirm existence, never interpret a generic CLI failure as a missing pane.
		const unavailable = new Set<DisplaySlot>();
		for (const slot of [...this.#slots]) {
			try {
				if (slot.needsPersistence) {
					await this.#service.setHerdrTarget(slot.agent.name, slot.target, true);
					slot.needsPersistence = false;
					this.#creationUncertain = false;
				}
				const target = await this.#api.getPane(slot.target.paneId);
				if (target.paneId !== slot.target.paneId) throw new Error("Herdr returned a different pane identity.");
				slot.target = target;
			} catch (error) {
				if (error instanceof HerdrPaneMissingError) {
					await this.#forgetSlot(slot);
				} else {
					unavailable.add(slot);
					this.#error(error, slot.agent.name);
				}
			}
		}

		// Prefer active displays, and among them retain the oldest assignments.
		const excess = [...this.#slots].sort((a, b) =>
			Number(a.agent.active && !a.yielding) - Number(b.agent.active && !b.yielding)
			|| (a.agent.active && !a.yielding ? b.assignedAt - a.assignedAt : a.agent.idleSince - b.agent.idleSince));
		for (const slot of excess) {
			if (this.#slots.length <= this.#paneLimit) break;
			if (unavailable.has(slot)) continue;
			try {
				await this.#api.closePane(slot.target.paneId);
				await this.#forgetSlot(slot);
			} catch (error) { this.#error(error, slot.agent.name); }
		}

		for (const slot of this.#slots) {
			if (unavailable.has(slot)) continue;
			try {
				if (this.#currentPane !== undefined && (slot.relocate || slot.target.tabId !== this.#currentPane.tabId)) {
					const index = this.#slots.indexOf(slot);
					const previous = this.#slots.slice(0, index).filter((candidate) => !unavailable.has(candidate)).at(-1);
					slot.target = await this.#api.movePane(slot.target.paneId, this.#currentPane.tabId,
						previous?.target.paneId ?? this.#currentPane.paneId, slot.agent.name, previous === undefined ? "right" : "down");
					await this.#service.setHerdrTarget(slot.agent.name, slot.target);
					slot.relocate = false;
					this.#layoutDirty = true;
				}
			} catch (error) { unavailable.add(slot); this.#error(error, slot.agent.name); }
		}

		const waiting = [...this.#agents.values()]
			.filter((agent) => agent.active && !this.#slots.some((slot) => slot.agent === agent && (!slot.yielding || unavailable.has(slot))))
			.sort((a, b) => a.order - b.order);
		for (const agent of waiting) {
			const own = this.#slots.find((slot) => slot.agent === agent && slot.yielding && !unavailable.has(slot));
			const idle = own ?? this.#slots.filter((slot) => (!slot.agent.active || slot.yielding) && !unavailable.has(slot))
				.sort((a, b) => a.agent.idleSince - b.agent.idleSince)[0];
			if (idle !== undefined && this.#slots.length <= this.#paneLimit) {
				try {
					if (idle.agent === agent) idle.yielding = false;
					else await this.#assign(idle, agent);
				}
				catch (error) { unavailable.add(idle); this.#error(error, agent.name); }
			} else if (this.#slots.length < this.#paneLimit && !this.#creationUncertain && !importFailed) {
				if (!await this.#createSlot(agent)) break;
			}
		}
		for (const slot of this.#slots) {
			if (unavailable.has(slot)) continue;
			try { await this.#publish(slot); }
			catch (error) { this.#error(error, slot.agent.name); }
		}
		await this.#equalizeAgentPaneHeights();
	}

	async #forgetSlot(slot: DisplaySlot): Promise<void> {
		// Once close succeeded (or absence was confirmed), the physical slot is free
		// even if clearing its stale durable association temporarily fails.
		this.#slots.splice(this.#slots.indexOf(slot), 1);
		this.#layoutDirty = true;
		try { await this.#service.setHerdrTarget(slot.agent.name, undefined); }
		catch (error) { this.#error(error, slot.agent.name); }
	}

	async #createSlot(agent: WatchedAgent): Promise<boolean> {
		const placement = this.#placement();
		let target: HerdrTarget;
		try {
			// Reserve durably before invoking a non-idempotent external split. If the
			// process dies after split but before its target is saved, reload cannot retry.
			await this.#service.setHerdrPaneCreationPending(true);
		} catch (error) {
			this.#error(error, agent.name);
			return false;
		}
		try {
			target = await this.#api.createPane(this.#cwd, agent.name, placement.anchorPaneId, placement.direction);
		} catch (error) {
			if (error instanceof HerdrPaneCreationRejectedError) {
				try { await this.#service.setHerdrPaneCreationPending(false); }
				catch (storageError) { this.#creationUncertain = true; this.#error(storageError, agent.name); }
				this.#error(error, agent.name);
			} else {
				this.#creationUncertain = true;
				this.#error(new Error("Herdr split outcome is uncertain; further pane creation is suspended to prevent duplicates.", { cause: error }), agent.name);
			}
			return false;
		}
		const slot: DisplaySlot = {
			target, agent, assignedAt: ++this.#clock, relocate: false,
			headerWritten: false, identity: agent.identity, toolCalls: new Map(),
			reset: false, awaitingReplay: true,
		};
		// Count the physical pane immediately, including when persistence fails.
		this.#slots.push(slot);
		this.#layoutDirty = true;
		try { await this.#service.setHerdrTarget(agent.name, target, true); }
		catch (error) {
			slot.needsPersistence = true;
			this.#creationUncertain = true;
			this.#error(error, agent.name);
		}
		return true;
	}

	async #assign(slot: DisplaySlot, agent: WatchedAgent): Promise<void> {
		const previous = slot.agent;
		// Invalidate confirmed output even if a failed earlier cleanup left this
		// destination with a stale association to the very same physical pane.
		await this.#service.setHerdrOutputVersion(agent.name, 0);
		// Persist the destination before removing the source: a crash can leave
		// duplicate associations (deduplicated at resume), never an untracked pane.
		await this.#service.setHerdrTarget(agent.name, slot.target);
		// Once reset starts, old occupant output must never be published again,
		// even if the clear acknowledgement is lost. Retry reset before new writes.
		slot.agent = agent;
		slot.yielding = false;
		slot.assignedAt = ++this.#clock;
		slot.reset = true;
		slot.headerWritten = false;
		slot.identity = agent.identity;
		slot.lastMetadata = undefined;
		slot.lastEntryId = undefined;
		slot.toolCalls.clear();
		slot.restoreCalls = false;
		slot.awaitingReplay = true;
		try { await this.#service.setHerdrTarget(previous.name, undefined); }
		catch (error) { this.#error(error, previous.name); }
	}

	async #readEntries(agent: WatchedAgent, start: EntryId | undefined, inclusive: boolean, end: EntryId | undefined): Promise<ConversationView["entries"]> {
		if (end === undefined || start === undefined) return [];
		const entries: ConversationView["entries"][number][] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await agent.conversation.entries({ order: "ascending", minEntryId: start, maxEntryId: end }, 256, cursor, BACKGROUND_CONTEXT);
			entries.push(...page.items.filter((entry) => inclusive ? entry.id >= start : entry.id > start));
			cursor = page.next;
		} while (cursor !== undefined);
		return entries;
	}

	async #publish(slot: DisplaySlot): Promise<void> {
		const agent = slot.agent;
		const view = agent.view;
		const identity = identityFromView(view, agent.identity);
		const end = latestEntryId(view);
		const replay = slot.awaitingReplay && agent.workStart !== undefined;
		if (slot.reset || (replay && slot.headerWritten)) {
			await this.#api.resetText(slot.target.paneId);
			slot.reset = false;
			slot.headerWritten = false;
			slot.lastEntryId = undefined;
			slot.toolCalls.clear();
		}
		const metadata = herdrMetadataForAgent(agent.name, identity.model, identity.thinking);
		const fingerprint = JSON.stringify(metadata);
		if (slot.lastMetadata !== fingerprint) {
			await this.#api.reportMetadata(slot.target.paneId, metadata);
			slot.lastMetadata = fingerprint;
		}
		if (slot.restoreCalls && agent.workStart !== undefined) {
			// Existing panes do not replay old text, but a tool begun before resume
			// may finish afterwards. Recover its arguments from the durable history.
			const history = await this.#readEntries(agent, agent.workStart, true, end);
			for (const entry of history) {
				recordToolCalls([entry], slot.toolCalls);
				if (ToolResultEntry.is(entry)) {
					const result = entry.model?.[0] as ToolResultMessage | undefined;
					if (result !== undefined) slot.toolCalls.delete(result.toolCallId);
				}
			}
			slot.restoreCalls = false;
		}
		let entries: ConversationView["entries"] = [];
		if (replay) {
			entries = await this.#readEntries(agent, agent.workStart, true, end);
		} else if (!slot.awaitingReplay) {
			entries = view.entries.filter((entry) => slot.lastEntryId === undefined || entry.id > slot.lastEntryId);
			if (slot.lastEntryId !== undefined && view.before !== undefined && view.before > slot.lastEntryId) {
				entries = await this.#readEntries(agent, slot.lastEntryId, false, end);
			}
		}
		const calls = new Map(slot.toolCalls);
		recordToolCalls(entries, calls);
		const lines: string[] = [];
		if (!slot.headerWritten) lines.push(herdrHeaderText(agent.name, identity.model, identity.thinking));
		else {
			if (!sameModel(identity.model, slot.identity.model)) lines.push(`[config] Model changed: ${modelLabel(identity.model)}`);
			if (identity.thinking !== slot.identity.thinking) lines.push(`[config] Thinking level changed: ${cleanText(identity.thinking, 32)}`);
		}
		for (const entry of entries) {
			const line = appendEntryLine(entry, calls);
			if (line !== undefined) lines.push(line);
		}
		if (lines.length > 0) await this.#api.appendText(slot.target.paneId, lines.join("\n\n"));
		const wroteHeader = !slot.headerWritten;
		slot.headerWritten = true;
		slot.identity = identity;
		slot.toolCalls = calls;
		slot.lastEntryId = end;
		if (replay) slot.awaitingReplay = false;
		if (wroteHeader) await this.#service.setHerdrOutputVersion(agent.name, HERDR_OUTPUT_VERSION);
	}

	async #equalizeAgentPaneHeights(): Promise<void> {
		if (!this.#layoutDirty) return;
		this.#layoutDirty = false;
		const agentPanes = this.#slots.map((slot) => slot.target.paneId);
		if (agentPanes.length < 2) return;
		const rootPaneId = this.#currentPane?.paneId ?? agentPanes[0]!;
		const managed = new Set(agentPanes);
		try {
			for (let index = 0; index < agentPanes.length - 1; index++) {
				const rows = (await this.#api.paneLayout(rootPaneId)).filter((pane) => managed.has(pane.paneId)).sort((a, b) => a.rect.y - b.rect.y);
				if (rows.length !== agentPanes.length || rows.some((pane) => pane.rect.height <= 0)) return;
				const first = rows[0]!;
				if (rows.some((pane) => pane.rect.x !== first.rect.x || pane.rect.width !== first.rect.width)) return;
				for (let row = 1; row < rows.length; row++) {
					if (rows[row - 1]!.rect.y + rows[row - 1]!.rect.height !== rows[row]!.rect.y) return;
				}
				const pane = rows[index]!;
				const bottom = rows.at(-1)!.rect.y + rows.at(-1)!.rect.height;
				const remaining = bottom - pane.rect.y;
				const difference = (bottom - first.rect.y) / rows.length / remaining - pane.rect.height / remaining;
				if (Math.abs(difference) < 0.01) continue;
				await this.#api.resizePane(pane.paneId, difference > 0 ? "down" : "up", Math.abs(difference));
			}
		} catch (error) { this.#layoutDirty = true; this.#error(error, "layout"); }
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail;
		await Promise.allSettled([...this.#agents.values()].map((agent) => agent.watch.stop()));
		this.#agents.clear();
		// Panes are retained for resume. Budget changes, not runtime shutdown, close them.
	}
}
