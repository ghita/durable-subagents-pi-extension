import {
	defineDoc,
	type ConversationId,
	type EntryId,
	type JsonObject,
	type TaskId,
} from "@earendil-works/pi-durable";

export interface ManagedAgentRecord extends JsonObject {
	conversationId: ConversationId;
	herdrTarget: { tabId: string; paneId: string } | null;
	/** Confirmed terminal output format for this occupant; null requires reset/replay on restoration. */
	herdrOutputVersion: number | null;
	presetId: string | null;
	inheritModel: boolean;
	inheritThinking: boolean;
	incomingCount: number;
	outgoingCount: number;
	/** Latest request text shown in the running-agent footer. */
	latestTask: string;
	/** True until a later message is sent to this agent after its initial spawn. */
	fresh: boolean;
	reporterTaskIds: TaskId[];
	/** Stable identity and inclusive replay boundary of the latest continuous executing/queued period. */
	workKey: string | null;
	workStart: EntryId | null;
	/** All submissions in that period, including settled steers; absent on legacy records. */
	workReporterTaskIds: TaskId[] | null;
}

export interface ManagedReportRecord extends JsonObject {
	id: string;
	agentName: string;
	text: string;
	traceContext: Record<string, string> | null;
	delivered: boolean;
}

export interface SubagentsState extends JsonObject {
	/** A split may have created an untracked pane. Missing/null in legacy state means false. */
	herdrPaneCreationPending: boolean | null;
	agents: Record<string, ManagedAgentRecord>;
	reports: Record<string, ManagedReportRecord>;
}

export const SubagentsDoc = defineDoc<SubagentsState>({
	kind: "app.durable-subagents",
	version: 1,
	scope: "conversation" as const,
	history: "latest" as const,
	fork: "initial" as const,
	checkpointWhen: () => false,
	initial: () => ({ agents: {}, reports: {}, herdrPaneCreationPending: false }),
});
