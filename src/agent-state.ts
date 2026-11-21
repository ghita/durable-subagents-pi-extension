import {
	defineDoc,
	type ConversationId,
	type JsonObject,
	type TaskId,
} from "@earendil-works/pi-durable";

export interface ManagedAgentRecord extends JsonObject {
	conversationId: ConversationId;
	herdrTarget: { tabId: string; paneId: string } | null;
	/** Version of the append-only terminal header last written to its associated Herdr pane. */
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
}

export interface ManagedReportRecord extends JsonObject {
	id: string;
	agentName: string;
	text: string;
	delivered: boolean;
}

export interface SubagentsState extends JsonObject {
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
	initial: () => ({ agents: {}, reports: {} }),
});
