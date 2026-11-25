import {
	AssistantEntry,
	ToolResultEntry,
	UserEntry,
	defineExtension,
	defineTask,
	type ConversationId,
	type ContextView,
	type EntryId,
	type SettledSubmissionRecord,
	type TaskId,
} from "@earendil-works/pi-durable";
import { SubagentsDoc } from "./agent-state.ts";
import { withTelemetry } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { cappedContentAttributes, injectTelemetryContext, inTelemetrySpan, safeAddEvent } from "./telemetry.ts";

export interface ReporterInput {
	agentName: string;
	conversationId: ConversationId;
	message: string;
	taskText?: string;
	requestId: string;
	reportId: string;
}

type ReporterState = { phase: "deliver" };

function assistantText(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
}

const PRIVATE_ARGUMENT_KEY = /authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|headers?/i;

function redactArguments(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactArguments);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [
			key,
			PRIVATE_ARGUMENT_KEY.test(key) ? "[REDACTED]" : redactArguments(item),
		]));
	}
	return value;
}

function textContent(value: { content?: unknown } | undefined): string {
	if (typeof value?.content === "string") return value.content;
	if (!Array.isArray(value?.content)) return "";
	return value.content.flatMap((part) =>
		part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string"
			? [(part as { text: string }).text]
			: [],
	).join("");
}

function entriesForSubmission(view: ContextView, inputEntryId: EntryId, answerEntryId?: EntryId): ContextView["entries"] {
	const entries = view.entries;
	const start = entries.findIndex((entry) => entry.id === inputEntryId);
	const answer = answerEntryId === undefined
		? entries.length - 1
		: entries.findIndex((entry) => entry.id === answerEntryId);
	if (start < 0 || answer < start) return [];

	// A run may answer several steered submissions together. Assign each transcript segment to the
	// input that starts it: a later user entry closes this segment, and the final answer belongs to
	// the latest input. This avoids replaying prior turns or claiming shared run activity repeatedly.
	const nextInput = entries.findIndex((entry, index) => index > start && UserEntry.is(entry));
	const end = nextInput < 0 ? answer : Math.min(answer, nextInput - 1);
	return entries.slice(start, end + 1);
}

function captureConversationContent(
	span: TelemetrySpan | undefined,
	view: ContextView,
	inputEntryId: EntryId,
	answerEntryId?: EntryId,
): void {
	if (span === undefined) return;
	const calls = new Map<string, ToolCall>();
	for (const entry of entriesForSubmission(view, inputEntryId, answerEntryId)) {
		if (AssistantEntry.is(entry)) {
			const message = entry.model?.[0] as AssistantMessage | undefined;
			if (message?.role !== "assistant") continue;
			const response = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
			if (response.trim() !== "") safeAddEvent(span, "managed_agent.assistant_response", cappedContentAttributes("content", response));
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				calls.set(part.id, part);
				const argumentsText = JSON.stringify(redactArguments(part.arguments));
				safeAddEvent(span, "managed_agent.tool_call", {
					"tool.name": part.name,
					"tool.call_id": part.id,
					...cappedContentAttributes("tool.arguments", argumentsText),
				});
			}
			continue;
		}
		if (UserEntry.is(entry)) {
			const message = entry.model?.[0] as UserMessage | undefined;
			const text = textContent(message);
			if (text.trim() !== "") safeAddEvent(span, "managed_agent.user_message", cappedContentAttributes("content", text));
			continue;
		}
		if (ToolResultEntry.is(entry)) {
			const result = entry.model?.[0] as ToolResultMessage | undefined;
			if (result?.role !== "toolResult") continue;
			const call = calls.get(result.toolCallId);
			const output = textContent(result);
			safeAddEvent(span, "managed_agent.tool_result", {
				"tool.name": call?.name ?? result.toolName,
				"tool.call_id": result.toolCallId,
				"tool.error": result.isError,
				...cappedContentAttributes("tool.output", output),
			});
			for (const nested of result.nestedCalls?.calls ?? []) {
				safeAddEvent(span, "managed_agent.nested_tool_call", {
					"tool.name": nested.name,
					"tool.call_id": nested.id,
					"tool.status": nested.status,
					...(nested.arguments === undefined ? {} : cappedContentAttributes("tool.arguments", JSON.stringify(redactArguments(nested.arguments)))),
					...(nested.argumentsBytes === undefined ? {} : { "tool.arguments.truncated": true, "tool.arguments.original_size_bytes": nested.argumentsBytes }),
				});
			}
		}
	}
}

async function captureSubmissionContentBestEffort(
	span: TelemetrySpan | undefined,
	inputEntryId: EntryId | undefined,
	answerEntryId: EntryId | undefined,
	readView: () => Promise<ContextView>,
): Promise<void> {
	if (span === undefined || inputEntryId === undefined) return;
	try {
		captureConversationContent(span, await readView(), inputEntryId, answerEntryId);
	} catch {
		// Transcript inspection is diagnostic-only; it must not change agent or report behavior.
	}
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

/**
 * Root-owned background task that submits work to a child conversation and waits for that submission to settle.
 * Its `deliver` phase captures request-local transcript activity, persists a report with trace context, and leaves
 * delivery to the Pi host adapter.
 */
export const AgentReporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.durable-subagents.reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const { agentName, conversationId, message, taskText, requestId, reportId } = task.input;
			await inTelemetrySpan(
				context.telemetry,
				{
					name: "durable_subagents.execution",
					attributes: {
						"managed_agent.name": agentName,
						"managed_agent.request_id": requestId,
						...cappedContentAttributes("managed_agent.task.text", taskText ?? message),
					},
				},
				async (span) => {
					const executionContext = span === undefined ? context : withTelemetry(span, context);
					const child = await runtime.conversation(conversationId, executionContext);
					if (child === undefined) throw new Error(`Managed agent "${agentName}" has no durable conversation.`);

					const submission = await child.submit(
						{ type: "input", content: message, whenBusy: "steer", requestId },
						executionContext,
					);
					let settled: SettledSubmissionRecord;
					try {
						settled = await submission.wait(executionContext);
					} catch (error) {
						// A failed wait can still leave useful, committed transcript activity behind.
						// Capture it best-effort, without replacing the original failure.
						try {
							const status = await submission.status(executionContext);
							if (status.type === "input") {
								const answerEntryId = status.status === "done" ? status.answer : undefined;
								await captureSubmissionContentBestEffort(
									span,
									status.entry,
									answerEntryId,
									() => runtime.context(
										conversationId,
										executionContext,
										answerEntryId === undefined ? {} : { at: answerEntryId },
									),
								);
							}
						} catch {
							// A failed status read must not replace the original submission failure.
						}
						safeAddEvent(span, "managed_agent.execution_failed", {
							"error.type": error instanceof Error ? error.name : typeof error,
						});
						throw error;
					}
					let reportText: string | undefined;

					if (settled.status === "unanswered") {
						if (settled.type === "input") {
							await captureSubmissionContentBestEffort(
								span,
								settled.entry,
								undefined,
								() => runtime.context(conversationId, executionContext),
							);
						}
						safeAddEvent(span, "managed_agent.execution_unanswered", {
							"managed_agent.execution.reason": settled.reason,
						});
						// Stop removes the current request without creating an outgoing report.
						if (settled.reason !== "aborted") reportText = `The request ended without an answer (${settled.reason}).`;
					} else if (settled.type === "input") {
						// Read the child's context at the settled answer so later turns or compaction cannot change the lookup.
						const answerContext = await runtime.context(conversationId, executionContext, { at: settled.answer });
						const answerEntry = answerContext.entries.find((entry) =>
							entry.id === settled.answer && AssistantEntry.is(entry),
						);
						const answer = answerEntry?.model?.[0] as AssistantMessage | undefined;
						reportText = assistantText(answer) || "The agent finished without a text response.";
						captureConversationContent(span, answerContext, settled.entry, settled.answer);
					}

					if (reportText !== undefined) {
						safeAddEvent(span, "managed_agent.report_created", cappedContentAttributes("managed_agent.report.text", reportText));
					}
					const traceContext = injectTelemetryContext(span);
					await runtime.commit(async (tx) => {
						if (reportText !== undefined) {
							const state = await tx.doc(SubagentsDoc, runtime.conversationId);
							if (!Object.hasOwn(state.reports, reportId)) {
								state.reports[reportId] = {
									id: reportId,
									agentName,
									text: reportText,
									delivered: false,
									traceContext: traceContext ?? null,
								};
							}
						}
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}, executionContext);
				},
			);
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
