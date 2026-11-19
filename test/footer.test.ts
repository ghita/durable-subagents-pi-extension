import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentFooterSummary, AgentService } from "../src/agent-service.ts";
import { AgentFooterController, renderAgentFooterLines } from "../src/footer.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

function summary(name: string, overrides: Partial<AgentFooterSummary> = {}): AgentFooterSummary {
	return {
		name,
		conversationId: `conversation-${name}` as unknown as AgentFooterSummary["conversationId"],
		active: true,
		queued: false,
		presetId: null,
		incomingCount: 2,
		outgoingCount: 1,
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.0042 },
		modelLabel: "gpt-6-luna",
		thinkingLevel: "low",
		turns: 12,
		toolUses: 12,
		contextTokens: 29_000,
		contextWindow: 1_000_000,
		latestTask: "Inspect the sample and report the important details.",
		fresh: true,
		...overrides,
	};
}

describe("agent footer formatting", () => {
	it("renders the spinner, agent identity, requested metrics, and latest task", () => {
		const lines = renderAgentFooterLines([summary("scout")], 150, 8, true, theme);
		const rendered = lines.join("\n");

		expect(rendered).toContain("⠇ scout [fresh] · running (gpt-6-luna · thinking low)");
		expect(rendered).toContain("12 turns");
		expect(rendered).toContain("12 tool uses");
		expect(rendered).toContain("messages in/out 2/1");
		expect(rendered).toContain("$0.004200");
		expect(rendered).toContain("ctx ≈29k/1M (3%)");
		expect(rendered).toContain("task: Inspect the sample and report the important details.");
	});

	it("renders a queued agent before its child conversation starts", () => {
		const lines = renderAgentFooterLines([summary("scout", { active: false, queued: true })], 150, 8, false, theme);

		expect(lines.join("\n")).toContain("… scout [fresh] · queued (gpt-6-luna · thinking low)");
	});

	it("renders the last agent status as idle when it is no longer running", () => {
		const lines = renderAgentFooterLines([summary("scout", { active: false })], 150, 8, true, theme);
		const rendered = lines.join("\n");

		expect(rendered).toContain("○ scout [fresh] · idle (gpt-6-luna · thinking low)");
		expect(rendered).toContain("task: Inspect the sample and report the important details.");
	});

	it("keeps every running-agent status line on narrow terminals and can omit task previews", () => {
		const agents = [summary("alpha"), summary("beta", { fresh: false, latestTask: "Second task." })];
		const lines = renderAgentFooterLines(agents, 32, 1, false, theme);

		expect(lines.join("\n")).toContain("alpha");
		expect(lines.join("\n")).toContain("beta");
		expect(lines.some((line) => line.includes("task:"))).toBe(false);
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it("keeps the footer installed for three seconds after the last agent becomes idle", async () => {
		vi.useFakeTimers();
		let controller: AgentFooterController | undefined;
		try {
			const setFooter = vi.fn();
			const context = {
				mode: "tui",
				ui: { setFooter },
				cwd: "/workspace",
				model: undefined,
				thinkingLevel: "off",
				getContextUsage: () => undefined,
				sessionManager: {
					getCwd: () => "/workspace",
					getEntries: () => [],
					getLeafId: () => null,
					getSessionName: () => undefined,
				},
			} as unknown as ExtensionContext;
			const service = {
				footerSummaries: vi.fn().mockResolvedValueOnce([summary("scout")]).mockResolvedValue([]),
			} as unknown as AgentService;
			controller = new AgentFooterController(context, service);
			controller.wake();
			await vi.advanceTimersByTimeAsync(0);
			expect(setFooter).toHaveBeenCalledWith(expect.any(Function));

			await vi.advanceTimersByTimeAsync(1_000);
			expect(setFooter).not.toHaveBeenLastCalledWith(undefined);
			await vi.advanceTimersByTimeAsync(2_999);
			expect(setFooter).not.toHaveBeenLastCalledWith(undefined);
			await vi.advanceTimersByTimeAsync(1);
			expect(setFooter).toHaveBeenLastCalledWith(undefined);
		} finally {
			controller?.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps an empty footer installed in always-on mode and restores activity-only hiding when disabled", async () => {
		vi.useFakeTimers();
		let controller: AgentFooterController | undefined;
		try {
			const setFooter = vi.fn();
			const context = {
				mode: "tui",
				ui: { setFooter },
				cwd: "/workspace",
				model: undefined,
				thinkingLevel: "off",
				getContextUsage: () => undefined,
				sessionManager: {
					getCwd: () => "/workspace",
					getEntries: () => [],
					getLeafId: () => null,
					getSessionName: () => undefined,
				},
			} as unknown as ExtensionContext;
			const service = { footerSummaries: vi.fn().mockResolvedValue([]) } as unknown as AgentService;
			controller = new AgentFooterController(context, service);
			controller.setAlwaysOn(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(setFooter).toHaveBeenCalledWith(expect.any(Function));

			await vi.advanceTimersByTimeAsync(5_000);
			expect(setFooter).not.toHaveBeenLastCalledWith(undefined);

			controller.setAlwaysOn(false);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(2_999);
			expect(setFooter).not.toHaveBeenLastCalledWith(undefined);
			await vi.advanceTimersByTimeAsync(1);
			expect(setFooter).toHaveBeenLastCalledWith(undefined);
		} finally {
			controller?.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps the most recent agent summary visible after it becomes idle in always-on mode", async () => {
		vi.useFakeTimers();
		let controller: AgentFooterController | undefined;
		let factory: ((...args: any[]) => any) | undefined;
		let component: any;
		try {
			const setFooter = vi.fn((value: unknown) => {
				if (typeof value === "function") factory = value as (...args: any[]) => any;
			});
			const context = {
				mode: "tui",
				ui: { setFooter },
				cwd: "/workspace",
				model: undefined,
				thinkingLevel: "off",
				getContextUsage: () => undefined,
				sessionManager: {
					getCwd: () => "/workspace",
					getEntries: () => [],
					getLeafId: () => null,
					getSessionName: () => undefined,
				},
			} as unknown as ExtensionContext;
			const service = {
				footerSummaries: vi.fn()
					.mockResolvedValueOnce([summary("scout")])
					.mockResolvedValueOnce([summary("scout", { active: false })])
					.mockResolvedValue([]),
			} as unknown as AgentService;
			controller = new AgentFooterController(context, service, true);
			controller.wake();
			await vi.advanceTimersByTimeAsync(0);
			expect(factory).toBeTypeOf("function");
			expect(service.footerSummaries).toHaveBeenLastCalledWith(true);

			const tui = { terminal: { rows: 30 }, requestRender: vi.fn() };
			const footerData = {
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				getAvailableProviderCount: () => 1,
				onBranchChange: () => () => undefined,
			};
			component = factory!(tui, theme, footerData);
			expect(component.render(160).join("\n")).toContain("scout [fresh] · running");

			await vi.advanceTimersByTimeAsync(1_000);
			expect(component.render(160).join("\n")).toContain("scout [fresh] · idle");
			expect(component.render(160).join("\n")).toContain("task: Inspect the sample and report the important details.");
			await vi.advanceTimersByTimeAsync(5_000);
			expect(setFooter).not.toHaveBeenLastCalledWith(undefined);
		} finally {
			controller?.dispose();
			component?.dispose();
			vi.useRealTimers();
		}
	});

	it("installs a structured footer for active agents and restores the default on disposal", async () => {
		let factory: ((...args: any[]) => any) | undefined;
		const setFooter = vi.fn((value: unknown) => {
			if (typeof value === "function") factory = value as (...args: any[]) => any;
		});
		const context = {
			mode: "tui",
			ui: { setFooter },
			cwd: "/workspace",
			model: undefined,
			thinkingLevel: "off",
			getContextUsage: () => undefined,
			sessionManager: {
				getCwd: () => "/workspace",
				getEntries: () => [],
				getLeafId: () => null,
				getSessionName: () => undefined,
			},
		} as unknown as ExtensionContext;
		const service = { footerSummaries: vi.fn().mockResolvedValue([summary("scout")]) } as unknown as AgentService;
		const controller = new AgentFooterController(context, service);
		controller.wake();
		await vi.waitFor(() => expect(factory).toBeTypeOf("function"));

		const tui = { terminal: { rows: 30 }, requestRender: vi.fn() };
		const footerData = {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => undefined,
		};
		const component = factory!(tui, theme, footerData);
		const firstRender = component.render(160).join("\n");
		expect(firstRender).toContain("scout [fresh]");
		expect(firstRender).toContain("/workspace");

		controller.wake();
		await vi.waitFor(() => expect(tui.requestRender).toHaveBeenCalled());
		expect(component.render(160).join("\n")).not.toBe(firstRender);
		controller.dispose();
		expect(setFooter).toHaveBeenLastCalledWith(undefined);
		component.dispose();
	});
});
