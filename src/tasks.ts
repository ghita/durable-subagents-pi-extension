import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	defineExtension,
	defineTask,
	type ConversationId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { SubagentsDoc } from "./agent-state.ts";

export interface ReporterInput {
	agentName: string;
	conversationId: ConversationId;
	message: string;
	requestId: string;
	reportId: string;
}

type ReporterState = { phase: "deliver" };

function assistantText(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
}

/** Each child conversation is owned by a short-lived background anchor. */
export const AgentAnchor = defineTask<null, { phase: "done" }, null>({
	name: "app.durable-subagents.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Durable delivery into a child, followed by a persisted report mailbox entry for the Pi host adapter. */
export const AgentReporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.durable-subagents.reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const { agentName, conversationId, message, requestId, reportId } = task.input;
			const child = await runtime.conversation(conversationId, context);
			if (child === undefined) throw new Error(`Managed agent "${agentName}" has no durable conversation.`);

			const submission = await child.submit(
				{ type: "input", content: message, whenBusy: "steer", requestId },
				context,
			);
			const settled = await submission.wait(context);
			let reportText: string | undefined;

			if (settled.status === "unanswered") {
				// Stop removes the current request without creating an outgoing report.
				if (settled.reason !== "aborted") reportText = `The request ended without an answer (${settled.reason}).`;
			} else if (settled.type === "input") {
				const answerEntry = await runtime.entry(AssistantEntry, settled.answer, context);
				const answer = answerEntry?.model?.[0] as AssistantMessage | undefined;
				reportText = assistantText(answer) || "The agent finished without a text response.";
			}

			await runtime.commit(async (tx) => {
				if (reportText !== undefined) {
					const state = await tx.doc(SubagentsDoc, runtime.conversationId);
					if (!Object.hasOwn(state.reports, reportId)) {
						state.reports[reportId] = { id: reportId, agentName, text: reportText, delivered: false };
					}
				}
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		// Stopping an outstanding reporter also closes the race where it has not yet submitted into the child.
		const child = await runtime.conversation(task.input.conversationId, context);
		await child?.abort(context);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

export const SubagentTasksExtension = defineExtension({
	name: "durable-subagents-tasks",
	tasks: [AgentAnchor, AgentReporter],
});

export type ReporterTaskId = TaskId<null>;
