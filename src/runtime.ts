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
): Promise<ManagedSessionRuntime> {
	const optInTelemetry: OptInTelemetry | undefined = createOptInTelemetry();
	const telemetry = optInTelemetry?.context;
	const sessionFile = requireSessionFile(context.sessionManager.getSessionFile());
	const databasePath = durableDatabasePath(sessionFile);
	const cwd = context.cwd;
	const presets = await loadPresetCatalog(getAgentDir());
	const storage = await openNodeSqliteStorage(databasePath);
	const registry = createRegistry();
	registry.install(CodingTools);
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
	});
	await service.updateInherited(parentModel, parentThinking);

	const herdr = herdrApiFromEnvironment();
	const herdrMonitor = herdr === undefined
		? undefined
		: new HerdrAgentMonitor({
			api: herdr.api,
			currentPane: herdr.currentPane,
			cwd,
			harness,
			service,
			onError: () => undefined,
		});
	if (herdrMonitor !== undefined) {
		try {
			await herdrMonitor.attachPersistedAgents();
		} catch {
			// Herdr pane restoration is optional and must not affect durable work.
		}
	}
	let drainTail: Promise<void> = Promise.resolve();
	let isClosed = false;
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
			advance: () => drainReports(),
			end: () => undefined,
		},
		BACKGROUND_CONTEXT,
	);
	if (observation === undefined) throw new Error("Unable to observe the managed-agent registry document.");

	harness.resume();
	drainReports();

	return {
		sessionFile,
		databasePath,
		service,
		herdrMonitor,
		telemetry,
		async close() {
			if (isClosed) return;
			isClosed = true;
			observation.detach();
			try {
				await herdrMonitor?.close();
			} catch {
				// Optional pane cleanup must not prevent Durable or telemetry shutdown.
			}
			await drainTail;
			try {
				await harness.close(BACKGROUND_CONTEXT);
			} finally {
				await optInTelemetry?.close();
			}
		},
	};
}
