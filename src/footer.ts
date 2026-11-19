import { relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentFooterSummary, AgentService } from "./agent-service.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FOOTER_REFRESH_MS = 1_000;
const FOOTER_HIDE_DELAY_MS = 3_000;

interface FooterUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface FooterSessionEntry {
	type: string;
	usage?: FooterUsage;
	message?: { role?: string; usage?: FooterUsage };
}

interface FooterUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

type FooterFactory = Exclude<Parameters<ExtensionContext["ui"]["setFooter"]>[0], undefined>;
type FooterTui = Parameters<FooterFactory>[0];
type FooterTheme = Parameters<FooterFactory>[1];
type FooterData = Parameters<FooterFactory>[2];

interface ParentUsageSnapshot {
	leafId: string | null;
	totals: FooterUsageTotals;
	latestCacheHitRate?: number;
}

const parentUsageCache = new WeakMap<ExtensionContext, ParentUsageSnapshot>();

function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatContextWindow(count: number): string {
	if (count >= 1_000_000 && count % 1_000_000 === 0) return `${count / 1_000_000}M`;
	return formatTokens(count);
}

function sanitizeLine(text: string): string {
	return text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function shortenCwd(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home) return cwd;
	const relativeToHome = relative(resolve(home), resolve(cwd));
	const insideHome = relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !relativeToHome.startsWith(sep));
	return insideHome ? (relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`) : cwd;
}

function addUsage(totals: FooterUsageTotals, usage: FooterUsage | undefined): void {
	if (usage === undefined) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

function getParentUsageSnapshot(context: ExtensionContext): ParentUsageSnapshot {
	const leafId = context.sessionManager.getLeafId();
	const cached = parentUsageCache.get(context);
	if (cached?.leafId === leafId) return cached;

	const totals: FooterUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const value of context.sessionManager.getEntries() as readonly FooterSessionEntry[]) {
		if (value.type === "usage" || value.type === "branch_summary" || value.type === "compaction") {
			addUsage(totals, value.usage);
		} else if (value.type === "message" && value.message?.role === "assistant") {
			const usage = value.message.usage;
			addUsage(totals, usage);
			if (usage !== undefined) {
				const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				latestCacheHitRate = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
			}
		} else if (value.type === "message" && value.message?.role === "toolResult") {
			addUsage(totals, value.message.usage);
		}
	}
	const snapshot = { leafId, totals, latestCacheHitRate };
	parentUsageCache.set(context, snapshot);
	return snapshot;
}

function getParentFooterLines(
	context: ExtensionContext,
	theme: FooterTheme,
	footerData: FooterData,
	width: number,
): string[] {
	const { totals, latestCacheHitRate } = getParentUsageSnapshot(context);

	let cwd = shortenCwd(context.sessionManager.getCwd() || context.cwd);
	const branch = footerData.getGitBranch();
	if (branch) cwd = `${cwd} (${branch})`;
	const sessionName = context.sessionManager.getSessionName();
	if (sessionName) cwd = `${cwd} • ${sessionName}`;
	const pwdLine = truncateToWidth(theme.fg("dim", cwd), width, theme.fg("dim", "…"));

	const stats: string[] = [];
	if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);

	const model = context.model;
	const contextUsage = context.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const contextPercent = contextUsage?.percent;
	const contextDisplay = contextPercent === null || contextPercent === undefined
		? `?/${contextWindow ? formatTokens(contextWindow) : "?"}`
		: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
	const contextColor = (value: string): string => theme.fg(
		contextPercent !== null && contextPercent !== undefined && contextPercent > 90
			? "error"
			: contextPercent !== null && contextPercent !== undefined && contextPercent > 70
				? "warning"
				: "dim",
		value,
	);
	stats.push(contextColor(contextDisplay));

	let right = model?.id ?? "no-model";
	if (model?.reasoning) {
		const thinking = context.thinkingLevel || "off";
		right += thinking === "off" ? " • thinking off" : ` • ${thinking}`;
	}
	if (footerData.getAvailableProviderCount() > 1 && model) {
		const withProvider = `(${model.provider}) ${right}`;
		if (visibleWidth(stats.join(" ")) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
	}

	const left = theme.fg("dim", stats.join(" "));
	const rightText = theme.fg("dim", right);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(rightText);
	let statsLine: string;
	if (leftWidth + 2 + rightWidth <= width) {
		statsLine = `${left}${" ".repeat(width - leftWidth - rightWidth)}${rightText}`;
	} else {
		const leftAvailable = Math.max(0, width - rightWidth - 2);
		if (leftAvailable > 0) {
			const clippedLeft = truncateToWidth(left, leftAvailable, theme.fg("dim", "…"));
			statsLine = `${clippedLeft}${" ".repeat(Math.max(1, width - visibleWidth(clippedLeft) - rightWidth))}${rightText}`;
		} else {
			statsLine = truncateToWidth(rightText, width, theme.fg("dim", "…"));
		}
	}

	const lines = [pwdLine, statsLine];
	const statuses = [...footerData.getExtensionStatuses().entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeLine(text))
		.filter(Boolean);
	if (statuses.length > 0) {
		lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "…")));
	}
	return lines;
}

function agentSegments(agent: AgentFooterSummary, frame: number, theme: FooterTheme): string[] {
	const indicator = agent.active
		? theme.fg("accent", SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)
		: agent.queued
			? theme.fg("warning", "…")
			: theme.fg("dim", "○");
	const state = agent.active ? "running" : agent.queued ? "queued" : "idle";
	const identity = `${indicator} ${theme.bold(agent.name)}${agent.fresh ? " [fresh]" : ""} · ${state} (${agent.modelLabel} · thinking ${agent.thinkingLevel})`;
	const context = agent.contextTokens === null ? "ctx ?" : `ctx ≈${formatTokens(agent.contextTokens)}`;
	const contextLimit = agent.contextWindow === null ? "?" : formatContextWindow(agent.contextWindow);
	const contextPercent = agent.contextTokens !== null && agent.contextWindow !== null && agent.contextWindow > 0
		? ` (${Math.round((agent.contextTokens / agent.contextWindow) * 100)}%)`
		: "";
	return [
		identity,
		`${agent.turns} turns`,
		`${agent.toolUses} tool uses`,
		`messages in/out ${agent.incomingCount}/${agent.outgoingCount}`,
		`$${agent.usage.cost.toFixed(6)}`,
		`${context}/${contextLimit}${contextPercent}`,
	];
}

function renderWrappedSegments(segments: readonly string[], width: number, theme: FooterTheme): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	let line = "";
	for (const segment of segments) {
		const candidate = line.length === 0 ? segment : `${line} · ${segment}`;
		if (line.length > 0 && visibleWidth(candidate) > width) {
			lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
			line = `  ${segment}`;
		} else {
			line = candidate;
		}
	}
	if (line.length > 0) lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
	return lines;
}

export function renderAgentFooterLines(
	agents: readonly AgentFooterSummary[],
	width: number,
	spinnerFrame: number,
	includeTasks: boolean,
	theme: FooterTheme,
): string[] {
	const lines: string[] = [];
	for (const [index, agent] of agents.entries()) {
		const segments = agentSegments(agent, spinnerFrame + index, theme);
		lines.push(...renderWrappedSegments(segments, width, theme));
		if (includeTasks && agent.latestTask.trim()) {
			const task = sanitizeLine(agent.latestTask);
			lines.push(truncateToWidth(`  task: ${task}`, width, theme.fg("dim", "…")));
		}
	}
	return lines;
}

export class AgentFooterController {
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;
	#refreshing = false;
	#refreshAgain = false;
	#installed = false;
	#spinnerFrame = 0;
	#agents: AgentFooterSummary[] = [];
	#tui: FooterTui | undefined;
	#alwaysOn: boolean;

	constructor(
		private readonly context: ExtensionContext,
		private readonly service: AgentService,
		alwaysOn = false,
	) {
		this.#alwaysOn = alwaysOn;
	}

	setAlwaysOn(alwaysOn: boolean): void {
		if (this.#disposed || this.#alwaysOn === alwaysOn) return;
		this.#alwaysOn = alwaysOn;
		this.wake();
	}

	wake(): void {
		if (this.#disposed) return;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		void this.#refresh();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#installed) this.context.ui.setFooter(undefined);
		this.#installed = false;
		this.#tui = undefined;
		this.#agents = [];
	}

	async #refresh(): Promise<void> {
		if (this.#disposed) return;
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return;
		}
		this.#refreshing = true;
		try {
			do {
				this.#refreshAgain = false;
				const agents = await this.service.footerSummaries(this.#alwaysOn);
				if (this.#disposed) return;
				this.#agents = agents;
				if (agents.some(({ active }) => active)) {
					this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;
				}
				if (agents.length > 0 || this.#alwaysOn) {
					if (!this.#installed) this.#installFooter();
					else this.#tui?.requestRender();
				} else {
					this.#tui?.requestRender();
				}
			} while (this.#refreshAgain && !this.#disposed);
		} catch {
			// A transient snapshot failure should not take the footer or the extension down.
		} finally {
			this.#refreshing = false;
			if (this.#disposed) return;
			if (this.#refreshAgain) {
				this.#refreshAgain = false;
				void this.#refresh();
			} else if (this.#agents.some(({ active, queued }) => active || queued)) {
				this.#timer = setTimeout(() => {
					this.#timer = undefined;
					void this.#refresh();
				}, FOOTER_REFRESH_MS);
			} else if (this.#installed && !this.#alwaysOn) {
				this.#timer = setTimeout(() => {
					this.#timer = undefined;
					if (this.#disposed || this.#agents.length > 0) return;
					this.context.ui.setFooter(undefined);
					this.#installed = false;
					this.#tui = undefined;
				}, FOOTER_HIDE_DELAY_MS);
			}
		}
	}

	#installFooter(): void {
		this.context.ui.setFooter((tui, theme, footerData) => {
			this.#tui = tui;
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				invalidate() {},
				dispose: () => {
					unsubscribe();
					if (this.#tui === tui) this.#tui = undefined;
				},
				render: (width: number) => {
					const defaultLines = getParentFooterLines(this.context, theme, footerData, width);
					const statusLines = renderAgentFooterLines(this.#agents, width, this.#spinnerFrame, false, theme);
					const leaveRoom = 6;
					const canShowTasks = tui.terminal.rows >= defaultLines.length + statusLines.length + this.#agents.length + leaveRoom;
					const agentLines = canShowTasks
						? renderAgentFooterLines(this.#agents, width, this.#spinnerFrame, true, theme)
						: statusLines;
					return [...agentLines, ...defaultLines];
				},
			};
		});
		this.#installed = true;
	}
}
