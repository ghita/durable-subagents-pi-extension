import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry, UserEntry, type AgentState, type ConversationId, type ConversationView, type ConversationWatch, type EntryId, type Harness, type ModelRef } from "@earendil-works/pi-durable";
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
}

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
	request: { type: "ping"; id: string } | { type: "append"; id: string; text: string },
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
		const output = await this.#run(args);
		const target = this.#paneTarget(output);
		try {
			await this.#run(["pane", "rename", target.paneId, label]);
		} catch {
			// The pane still works if Herdr cannot apply the display label.
		}
		return target;
	}

	async getPane(paneId: string): Promise<HerdrTarget> {
		return this.#paneTarget(await this.#run(["pane", "get", paneId]));
	}

	async movePane(paneId: string, tabId: string, anchorPaneId: string, label: string, direction: HerdrSplitDirection): Promise<HerdrTarget> {
		await this.#run([
			"pane", "move", paneId, "--tab", tabId, "--split", direction,
			"--target-pane", anchorPaneId, "--no-focus",
		]);
		try {
			await this.#run(["pane", "rename", paneId, label]);
		} catch {
			// The pane still works if Herdr cannot apply the display label.
		}
		return this.getPane(paneId);
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
	}

	async appendText(paneId: string, text: string): Promise<void> {
		const previous = this.#appendTails.get(paneId) ?? Promise.resolve();
		const queued = previous.catch(() => undefined).then(() => this.#appendTextNow(paneId, text));
		this.#appendTails.set(paneId, queued);
		try {
			await queued;
		} finally {
			if (this.#appendTails.get(paneId) === queued) this.#appendTails.delete(paneId);
		}
	}

	async #appendTextNow(paneId: string, text: string): Promise<void> {
		// Bootstrap the renderer once per pane; subsequent transcript updates use its local socket.
		const socketPath = rendererSocketPath(paneId);
		await this.#ensureRenderer(paneId, socketPath);
		const contents = text.endsWith("\n") ? text : `${text}\n`;
		await rendererRequest(socketPath, { type: "append", id: randomUUID(), text: contents });
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
	conversationId: ConversationId;
	target: HerdrTarget;
	watch: ConversationWatch;
	initialIdentity: AgentIdentity;
	currentIdentity: AgentIdentity;
	headerWritten: boolean;
	outputVersionPersisted: boolean;
	lastMetadata?: string;
	lastEntryId?: EntryId;
	toolCalls: Map<string, ToolCall>;
	publishTail: Promise<void>;
};

export interface HerdrAgentMonitorOptions {
	api: HerdrApi;
	currentPane?: HerdrTarget;
	cwd: string;
	harness: Harness;
	service: AgentService;
	onError?: (error: unknown, agentName: string) => void;
}

/** Creates one Herdr sibling pane per durable agent and streams committed conversation activity into its metadata and terminal. */
export class HerdrAgentMonitor {
	readonly #api: HerdrApi;
	readonly #currentPane?: HerdrTarget;
	readonly #cwd: string;
	readonly #harness: Harness;
	readonly #service: AgentService;
	readonly #onError: (error: unknown, agentName: string) => void;
	readonly #agents = new Map<string, WatchedAgent>();
	readonly #opening = new Map<string, Promise<void>>();
	#closed = false;

	constructor(options: HerdrAgentMonitorOptions) {
		this.#api = options.api;
		this.#currentPane = options.currentPane;
		this.#cwd = options.cwd;
		this.#harness = options.harness;
		this.#service = options.service;
		this.#onError = options.onError ?? ((error, name) => console.error(`[durable-subagents] Herdr update failed for ${name}:`, error));
	}

	#panePlacement(excludeName?: string): { anchorPaneId?: string; direction: HerdrSplitDirection } {
		const tracked = [...this.#agents.entries()].filter(([name]) => name !== excludeName);
		const lastAgent = tracked.at(-1)?.[1].target.paneId;
		if (lastAgent !== undefined) return { anchorPaneId: lastAgent, direction: "down" };
		if (this.#currentPane !== undefined) return { anchorPaneId: this.#currentPane.paneId, direction: "right" };
		return { direction: "right" };
	}

	async #equalizeAgentPaneHeights(agentName: string): Promise<void> {
		const agentPanes = [...this.#agents.values()].map((agent) => agent.target.paneId);
		if (agentPanes.length < 2) return;
		const rootPaneId = this.#currentPane?.paneId ?? agentPanes[0]!;
		const managed = new Set(agentPanes);

		try {
			for (let index = 0; index < agentPanes.length - 1; index++) {
				const rows = (await this.#api.paneLayout(rootPaneId))
					.filter((pane) => managed.has(pane.paneId))
					.sort((a, b) => a.rect.y - b.rect.y);
				if (rows.length !== agentPanes.length || rows.some((pane) => pane.rect.height <= 0)) return;
				const first = rows[0]!;
				if (rows.some((pane) => pane.rect.x !== first.rect.x || pane.rect.width !== first.rect.width)) return;
				for (let row = 1; row < rows.length; row++) {
					if (rows[row - 1]!.rect.y + rows[row - 1]!.rect.height !== rows[row]!.rect.y) return;
				}

				const pane = rows[index]!;
				const stackBottom = rows.at(-1)!.rect.y + rows.at(-1)!.rect.height;
				const remainingHeight = stackBottom - pane.rect.y;
				const desiredHeight = (stackBottom - first.rect.y) / rows.length;
				const currentRatio = pane.rect.height / remainingHeight;
				const desiredRatio = desiredHeight / remainingHeight;
				const difference = desiredRatio - currentRatio;
				if (Math.abs(difference) < 0.01) continue;
				await this.#api.resizePane(pane.paneId, difference > 0 ? "down" : "up", Math.abs(difference));
			}
		} catch (error) {
			this.#onError(error, agentName);
		}
	}

	async trackAgent(name: string, conversationId: ConversationId): Promise<void> {
		if (this.#closed) return;
		const tracked = this.#agents.get(name);
		if (tracked?.conversationId === conversationId) {
			if (await this.#ensurePane(name, tracked)) await this.#queuePublish(name, tracked, tracked.watch.value);
			return;
		}
		const opening = this.#opening.get(name);
		if (opening !== undefined) return opening;
		const promise = this.#trackAgent(name, conversationId);
		this.#opening.set(name, promise);
		try {
			await promise;
		} finally {
			if (this.#opening.get(name) === promise) this.#opening.delete(name);
		}
	}

	async #trackAgent(name: string, conversationId: ConversationId): Promise<void> {
		const existing = this.#agents.get(name);
		if (existing !== undefined) {
			await existing.watch.stop();
			this.#agents.delete(name);
		}

		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error(`Managed agent "${name}" has no conversation.`);
		const [agent, storedTarget, outputVersion] = await Promise.all([
			conversation.agent(BACKGROUND_CONTEXT),
			this.#service.herdrTarget(name),
			this.#service.herdrOutputVersion(name),
		]);
		let target = storedTarget;
		let targetNeedsPersist = false;
		let createdPane = false;
		if (storedTarget !== undefined) {
			try {
				target = await this.#api.getPane(storedTarget.paneId);
				targetNeedsPersist = target.tabId !== storedTarget.tabId || target.paneId !== storedTarget.paneId;
			} catch {
				target = undefined;
			}
		}
		if (target === undefined) {
			const placement = this.#panePlacement(name);
			target = await this.#api.createPane(this.#cwd, name, placement.anchorPaneId, placement.direction);
			targetNeedsPersist = true;
			createdPane = true;
		} else if (this.#currentPane !== undefined) {
			const placement = this.#panePlacement(name);
			target = await this.#api.movePane(target.paneId, this.#currentPane.tabId, placement.anchorPaneId ?? this.#currentPane.paneId, name, placement.direction);
			targetNeedsPersist = true;
		}
		if (targetNeedsPersist) await this.#service.setHerdrTarget(name, target);

		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		if (this.#closed) {
			await watch.stop();
			return;
		}
		const initialIdentity: AgentIdentity = { model: agent.model, thinking: agent.thinkingLevel };
		const watched: WatchedAgent = {
			conversationId,
			target,
			watch,
			initialIdentity,
			currentIdentity: initialIdentity,
			headerWritten: !createdPane && outputVersion === HERDR_OUTPUT_VERSION,
			outputVersionPersisted: !createdPane && outputVersion === HERDR_OUTPUT_VERSION,
			lastEntryId: createdPane ? watch.value.before : latestEntryId(watch.value),
			toolCalls: new Map(),
			publishTail: Promise.resolve(),
		};
		this.#agents.set(name, watched);
		await this.#equalizeAgentPaneHeights(name);
		await this.#queuePublish(name, watched, watch.value);
		watch.start(async (call) => {
			if (call.kind !== "value" || this.#closed) return;
			await this.#queuePublish(name, watched, call.value);
		});
	}

	async #ensurePane(name: string, watched: WatchedAgent): Promise<boolean> {
		let target: HerdrTarget | undefined;
		let recreated = false;
		try {
			target = await this.#api.getPane(watched.target.paneId);
		} catch {
			try {
				const placement = this.#panePlacement(name);
				target = await this.#api.createPane(this.#cwd, name, placement.anchorPaneId, placement.direction);
				recreated = true;
			} catch (error) {
				this.#onError(error, name);
				return false;
			}
		}

		if (recreated || target.paneId !== watched.target.paneId) {
			watched.target = target;
			watched.lastMetadata = undefined;
			watched.headerWritten = false;
			watched.outputVersionPersisted = false;
			try {
				await this.#service.setHerdrTarget(name, target);
			} catch (error) {
				this.#onError(error, name);
			}
			await this.#equalizeAgentPaneHeights(name);
		} else if (target.tabId !== watched.target.tabId) {
			watched.target = target;
			try {
				await this.#service.setHerdrTarget(name, target);
			} catch (error) {
				this.#onError(error, name);
			}
		}
		return true;
	}

	#queuePublish(name: string, watched: WatchedAgent, view: ConversationView): Promise<void> {
		const queued = watched.publishTail.then(() => this.#publish(name, watched, view));
		watched.publishTail = queued.catch((error) => this.#onError(error, name));
		return watched.publishTail;
	}

	async #publish(name: string, watched: WatchedAgent, view: ConversationView, allowRecovery = true): Promise<void> {
		let failed = false;
		const metadata = herdrMetadataForAgent(name, watched.initialIdentity.model, watched.initialIdentity.thinking);
		const fingerprint = JSON.stringify(metadata);
		if (fingerprint !== watched.lastMetadata) {
			try {
				await this.#api.reportMetadata(watched.target.paneId, metadata);
				watched.lastMetadata = fingerprint;
			} catch {
				failed = true;
			}
		}

		const nextIdentity = identityFromView(view, watched.currentIdentity);
		const nextToolCalls = new Map(watched.toolCalls);
		recordToolCalls(view.entries, nextToolCalls);
		const newEntries = view.entries.filter((entry) => watched.lastEntryId === undefined || entry.id > watched.lastEntryId);
		const lines: string[] = [];
		const writesHeader = !watched.headerWritten;
		if (writesHeader) {
			lines.push(herdrHeaderText(name, watched.currentIdentity.model, watched.currentIdentity.thinking));
		}
		if (!sameModel(nextIdentity.model, watched.currentIdentity.model)) {
			lines.push(`[config] Model changed: ${modelLabel(nextIdentity.model)}`);
		}
		if (nextIdentity.thinking !== watched.currentIdentity.thinking) {
			lines.push(`[config] Thinking level changed: ${cleanText(nextIdentity.thinking, 32)}`);
		}
		for (const entry of newEntries) {
			const line = appendEntryLine(entry, nextToolCalls);
			if (line !== undefined) lines.push(line);
		}

		let appendSucceeded = lines.length === 0;
		if (lines.length > 0) {
			try {
				await this.#api.appendText(watched.target.paneId, lines.join("\n\n"));
				appendSucceeded = true;
			} catch {
				failed = true;
			}
		}

		if (appendSucceeded) {
			if (writesHeader) watched.headerWritten = true;
			watched.currentIdentity = nextIdentity;
			watched.toolCalls = nextToolCalls;
			watched.lastEntryId = newEntries.at(-1)?.id ?? watched.lastEntryId ?? view.before;
		}
		if (watched.headerWritten && !watched.outputVersionPersisted) {
			try {
				await this.#service.setHerdrOutputVersion(name, HERDR_OUTPUT_VERSION);
				watched.outputVersionPersisted = true;
			} catch (error) {
				this.#onError(error, name);
			}
		}

		if (!failed) return;
		if (allowRecovery && await this.#ensurePane(name, watched)) {
			await this.#publish(name, watched, view, false);
			return;
		}
		this.#onError(new Error("Herdr pane updates failed."), name);
	}

	async attachPersistedAgents(): Promise<void> {
		for (const agent of await this.#service.herdrAgents()) {
			try {
				await this.trackAgent(agent.name, agent.conversationId);
			} catch (error) {
				this.#onError(error, agent.name);
			}
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.allSettled([...this.#opening.values()]);
		const agents = [...this.#agents.values()];
		this.#agents.clear();
		await Promise.all(agents.map((agent) => agent.watch.stop()));
	}
}
