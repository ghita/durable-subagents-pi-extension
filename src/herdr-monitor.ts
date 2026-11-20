import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, UserEntry, type AgentState, type ConversationId, type ConversationView, type ConversationWatch, type Harness, type LiveState } from "@earendil-works/pi-durable";
import type { AgentService, HerdrTarget } from "./agent-service.ts";

const execFileAsync = promisify(execFile);
const HERDR_SOURCE = "pi-durable-subagents";
const HERDR_AGENT = "pi";
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;

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
	writeProgress(paneId: string, text: string): Promise<void>;
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

/** Herdr's CLI is the supported client for its local socket API. */
export class HerdrCliApi implements HerdrApi {
	readonly #run: HerdrCommandRunner;
	readonly #currentTabId?: string;

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

	async writeProgress(paneId: string, text: string): Promise<void> {
		const encoded = Buffer.from(text, "utf8").toString("base64");
		const command = `node -e "process.stdout.write('\\x1b[3J\\x1b[2J\\x1b[H' + Buffer.from('${encoded}','base64').toString() + '\\n')"`;
		await this.#run(["pane", "run", paneId, command]);
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

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function cleanText(text: string, limit = 240): string {
	const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s{2,}/g, " ");
	return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

export function summarizeToolActivity(live: LiveState | undefined): string {
	if (live === undefined) return "No tool activity";
	const slots = [...(live.tools ?? []), ...(live.nestedTools ?? [])];
	if (slots.length === 0) return live.run === undefined ? "No active tool calls" : "Waiting for model";
	const summary = slots.slice(-8).map((slot) => `${slot.name} (${slot.status})`).join(", ");
	return cleanText(summary);
}

export function herdrMetadataForAgent(name: string, initialThinking: string, view: ConversationView): HerdrMetadata {
	const agent = view.docs["pi.agent"] as AgentState | undefined;
	const thinking = stringValue(agent?.thinkingLevel) ?? initialThinking;
	const live = view.docs["pi.live"] as LiveState | undefined;
	const activity = summarizeToolActivity(live);
	const status = live?.run === undefined ? "idle" : "working";
	return {
		displayAgent: cleanText(name, 100),
		title: cleanText(`${name} · ${thinking} · ${activity}`, 240),
		tokens: {
			thinking: cleanText(thinking, 32),
			activity: status,
			tools: activity,
		},
	};
}

function latestAssistantText(view: ConversationView): string {
	for (let index = view.entries.length - 1; index >= 0; index--) {
		const entry = view.entries[index];
		if (!AssistantEntry.is(entry)) continue;
		const message = entry.model?.[0] as AssistantMessage | undefined;
		const text = (message?.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
		if (text !== "") return cleanText(text, 600);
	}
	return "Waiting for response";
}

function recentInputMessages(view: ConversationView): string[] {
	const messages: string[] = [];
	for (const entry of view.entries) {
		if (!UserEntry.is(entry)) continue;
		const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "user") continue;
		const content = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.flatMap((part) => {
					if (part === null || typeof part !== "object") return [];
					const item = part as { type?: unknown; text?: unknown };
					return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
				}).join("")
				: "";
		const cleaned = cleanText(content, 500);
		if (cleaned !== "") messages.push(cleaned);
	}
	return messages.slice(-3);
}

export function herdrProgressText(name: string, initialThinking: string, view: ConversationView): string {
	const metadata = herdrMetadataForAgent(name, initialThinking, view);
	const inputs = recentInputMessages(view);
	return [
		`Durable agent: ${metadata.displayAgent}`,
		`Status: ${metadata.tokens.activity}`,
		`Thinking: ${metadata.tokens.thinking}`,
		`Tools: ${metadata.tokens.tools}`,
		"Recent inputs:",
		...(inputs.length === 0 ? ["(none)"] : inputs.map((input, index) => `${index + 1}. ${input}`)),
		`Latest response: ${latestAssistantText(view)}`,
	].join("\n");
}

type WatchedAgent = {
	conversationId: ConversationId;
	target: HerdrTarget;
	watch: ConversationWatch;
	initialThinking: string;
	lastMetadata?: string;
	lastProgress?: string;
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
			if (await this.#ensurePane(name, tracked)) await this.#publish(name, tracked, tracked.watch.value);
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
		const [agent, storedTarget] = await Promise.all([
			conversation.agent(BACKGROUND_CONTEXT),
			this.#service.herdrTarget(name),
		]);
		let target = storedTarget;
		let targetNeedsPersist = false;
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
		const watched: WatchedAgent = {
			conversationId,
			target,
			watch,
			initialThinking: agent.thinkingLevel,
		};
		this.#agents.set(name, watched);
		await this.#equalizeAgentPaneHeights(name);
		await this.#publish(name, watched, watch.value);
		watch.start(async (call) => {
			if (call.kind !== "value" || this.#closed) return;
			await this.#publish(name, watched, call.value);
		});
	}

	async #ensurePane(name: string, watched: WatchedAgent): Promise<boolean> {
		let target: HerdrTarget | undefined;
		try {
			target = await this.#api.getPane(watched.target.paneId);
		} catch {
			try {
				const placement = this.#panePlacement(name);
				target = await this.#api.createPane(this.#cwd, name, placement.anchorPaneId, placement.direction);
			} catch (error) {
				this.#onError(error, name);
				return false;
			}
		}

		if (target.tabId !== watched.target.tabId || target.paneId !== watched.target.paneId) {
			watched.target = target;
			watched.lastMetadata = undefined;
			watched.lastProgress = undefined;
			try {
				await this.#service.setHerdrTarget(name, target);
			} catch (error) {
				this.#onError(error, name);
			}
			await this.#equalizeAgentPaneHeights(name);
		}
		return true;
	}

	async #publish(name: string, watched: WatchedAgent, view: ConversationView, allowRecovery = true): Promise<void> {
		const metadata = herdrMetadataForAgent(name, watched.initialThinking, view);
		const fingerprint = JSON.stringify(metadata);
		let failed = false;
		if (fingerprint !== watched.lastMetadata) {
			try {
				await this.#api.reportMetadata(watched.target.paneId, metadata);
				watched.lastMetadata = fingerprint;
			} catch {
				failed = true;
			}
		}

		const progress = herdrProgressText(name, watched.initialThinking, view);
		if (progress !== watched.lastProgress) {
			try {
				await this.#api.writeProgress(watched.target.paneId, progress);
				watched.lastProgress = progress;
			} catch {
				failed = true;
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
