import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createRegistry,
	Harness,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { AgentService } from "./agent-service.ts";
import { HerdrAgentMonitor, herdrApiFromEnvironment } from "./herdr-monitor.ts";
import { SubagentsDoc } from "./agent-state.ts";
import { createPiModelBridge, modelReference } from "./model-bridge.ts";
import { loadPresetCatalog } from "./presets.ts";
import { durableDatabasePath, requireSessionFile } from "./storage-path.ts";
import { SubagentTasksExtension } from "./tasks.ts";
import { deliverPiReportWithTelemetry, hasPiReportEntry, type ReportEntryLike } from "./report-delivery.ts";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { createOptInTelemetry, type OptInTelemetry } from "./telemetry.ts";

export { durableDatabasePath, requireSessionFile } from "./storage-path.ts";

export interface ManagedSessionRuntime {
	sessionFile: string;
	databasePath: string;
	service: AgentService;
	herdrMonitor?: HerdrAgentMonitor;
	telemetry?: TelemetryContext;
	reportDisplayError(error: unknown): void;
	close(): Promise<void>;
}

function selectedModel(context: ExtensionContext): ModelRef {
	const model = context.model as Model<any> | undefined;
	if (model === undefined) throw new Error("Pi has no selected model; select a model before spawning managed agents.");
	return modelReference(model);
}

function selectedThinking(pi: ExtensionAPI, context: ExtensionContext): ModelThinkingLevel {
	return (pi.getThinkingLevel() ?? context.thinkingLevel ?? "off") as ModelThinkingLevel;
}

export async function openManagedSessionRuntime(
	pi: ExtensionAPI,
	context: ExtensionContext,
	paneLimit = 3,
): Promise<ManagedSessionRuntime> {
	const optInTelemetry: OptInTelemetry | undefined = createOptInTelemetry();
	try {
		return await initializeManagedSessionRuntime(pi, context, optInTelemetry, paneLimit);
	} catch (error) {
		await optInTelemetry?.close();
		throw error;
	}
}

async function initializeManagedSessionRuntime(
	pi: ExtensionAPI,
	context: ExtensionContext,
	optInTelemetry: OptInTelemetry | undefined,
	paneLimit: number,
): Promise<ManagedSessionRuntime> {
	const telemetry = optInTelemetry?.context;
	const sessionFile = requireSessionFile(context.sessionManager.getSessionFile());
	const databasePath = durableDatabasePath(sessionFile);
	const cwd = context.cwd;
	const presets = await loadPresetCatalog(getAgentDir());
	const storage = await openNodeSqliteStorage(databasePath);
	const codemodeSandbox = new CodemodeSandbox();
	const codemodeExtension = createCodemodeExtension({ sandbox: codemodeSandbox, models: false });
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(codemodeExtension);
	registry.install(SubagentTasksExtension);

	const harness = await Harness.open(
		storage,
		{
			models: createPiModelBridge(context.modelRegistry),
			registry,
			...(telemetry === undefined ? {} : { telemetry }),
			settings: { extensions: [CodingTools] },
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
		},
		BACKGROUND_CONTEXT,
	);

	const parentModel = selectedModel(context);
	const parentThinking = selectedThinking(pi, context);
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: parentModel, thinkingLevel: parentThinking, extensions: [CodingTools] },
	});
	await root.configure(
		{ model: parentModel, thinkingLevel: parentThinking, extensions: [CodingTools] },
		BACKGROUND_CONTEXT,
	);
	await root.commit(async (tx) => {
		await tx.doc(SubagentsDoc, root.id);
	}, BACKGROUND_CONTEXT);

	const service = new AgentService({
		harness,
		root,
		cwd,
		presets,
		modelRegistry: context.modelRegistry,
		parentModel,
		parentThinking,
		telemetry,
		codemodeExtension,
	});
	await service.updateInherited(parentModel, parentThinking);

	let lastDisplayWarning = -Infinity;
	const reportDisplayError = (error: unknown): void => {
		// One warning per 30 seconds across all panes, including refresh failures.
		if (Date.now() - lastDisplayWarning < 30_000) return;
		lastDisplayWarning = Date.now();
		const message = `Managed-agent display failed (agent work continues): ${error instanceof Error ? error.message : String(error)}`;
		try {
			if (context.hasUI) context.ui.notify(message, "warning");
			else console.error(message);
		} catch {
			// A detached/stale UI must not turn an optional display failure into a
			// rejected refresh tail or skip Durable/telemetry shutdown.
			try { console.error(message); } catch { /* No operational output sink remains. */ }
		}
	};
	const herdr = herdrApiFromEnvironment();
	const herdrMonitor = herdr === undefined
		? undefined
		: new HerdrAgentMonitor({
			api: herdr.api,
			currentPane: herdr.currentPane,
			cwd,
			harness,
			service,
			paneLimit,
			onError: reportDisplayError,
		});
	if (herdrMonitor !== undefined) {
		try {
			await herdrMonitor.attachPersistedAgents();
		} catch (error) {
			reportDisplayError(error);
		}
	}
	let drainTail: Promise<void> = Promise.resolve();
	let isClosed = false;
	let refreshInFlight: Promise<void> | undefined;
	const refreshDisplay = (): void => {
		if (isClosed || herdrMonitor === undefined || refreshInFlight !== undefined) return;
		refreshInFlight = herdrMonitor.refresh()
			.catch(reportDisplayError)
			.finally(() => { refreshInFlight = undefined; });
	};
	const drainReports = (): void => {
		drainTail = drainTail
			.then(async () => {
				if (isClosed) return;
				const reports = await service.pendingReports();
				for (const report of reports) {
					await deliverPiReportWithTelemetry(
						report,
						telemetry,
						{
							getEntries: () => context.sessionManager.getEntries() as ReportEntryLike[],
							sendMessage: (message, options) => pi.sendMessage(message, options),
							waitForRecorded: async (reportId) => {
								while (!isClosed) {
									if (hasPiReportEntry(context.sessionManager.getEntries() as ReportEntryLike[], reportId)) return true;
									await new Promise((resolve) => setTimeout(resolve, 50));
								}
								return false;
							},
						},
						(reportId) => service.markReportDelivered(reportId),
					);
				}
			})
			.catch((error) => {
				if (!isClosed) context.ui.notify(`Managed-agent report delivery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
	};

	const observation = await harness.observeDoc(
		SubagentsDoc,
		root.id,
		{
			// Display reconciliation persists pane metadata to this same document.
			// Poll separately rather than feeding those writes back into refresh.
			advance: () => drainReports(),
			end: () => undefined,
		},
		BACKGROUND_CONTEXT,
	);
	if (observation === undefined) throw new Error("Unable to observe the managed-agent registry document.");

	const displayTimer = herdrMonitor === undefined ? undefined : setInterval(refreshDisplay, 1_000);
	displayTimer?.unref();
	harness.resume();
	drainReports();

	return {
		sessionFile,
		databasePath,
		service,
		herdrMonitor,
		telemetry,
		reportDisplayError,
		async close() {
			if (isClosed) return;
			isClosed = true;
			clearInterval(displayTimer);
			observation.detach();
			await refreshInFlight;
			try {
				await herdrMonitor?.close();
			} catch (error) {
				reportDisplayError(error);
			}
			await drainTail;
			try {
				await harness.close(BACKGROUND_CONTEXT);
			} finally {
				try {
					await codemodeSandbox.close();
				} finally {
					await optInTelemetry?.close();
				}
			}
		},
	};
}
