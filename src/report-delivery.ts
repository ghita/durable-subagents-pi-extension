export const SUBAGENT_REPORT_TYPE = "durable-subagent-report";

export interface ReportEntryLike {
	type: string;
	customType?: string;
	details?: unknown;
}

export interface PiReportMessage {
	customType: typeof SUBAGENT_REPORT_TYPE;
	content: string;
	display: true;
	details: {
		reportId: string;
		agentName: string;
	};
}

export interface PiReportTransport {
	getEntries(): readonly ReportEntryLike[];
	sendMessage(
		message: PiReportMessage,
		options: { triggerTurn: true; deliverAs: "followUp" },
	): void;
	/** Resolve only after Pi's session manager contains the custom message; false means shutdown interrupted delivery. */
	waitForRecorded(reportId: string): Promise<boolean>;
}

export interface ManagedReport {
	id: string;
	agentName: string;
	text: string;
}

export function hasPiReportEntry(entries: readonly ReportEntryLike[], reportId: string): boolean {
	return entries.some((entry) => {
		if (entry.type !== "custom_message" || entry.customType !== SUBAGENT_REPORT_TYPE) return false;
		if (entry.details === null || typeof entry.details !== "object") return false;
		return (entry.details as { reportId?: unknown }).reportId === reportId;
	});
}

/**
 * Deliver a report as an extension-authored custom message, never as a user
 * command. Pi's public sendMessage API queues follow-ups while busy and starts
 * a turn when idle. Since Pi and Durable persist separately, the stable ID is
 * checked against the Pi transcript before acknowledging the durable report.
 *
 * Pi's sendMessage API returns void and a busy session may only enqueue the
 * custom message in memory. Do not acknowledge until the session manager shows
 * the appended transcript entry. Shutdown before that point leaves the report
 * pending for resume. The two stores still cannot transact atomically, so a
 * crash before the Pi append becomes visible can cause an at-least-once retry.
 */
export async function deliverPiReport(
	report: ManagedReport,
	transport: PiReportTransport,
	acknowledge: (reportId: string) => Promise<void>,
): Promise<{ deliveredNow: boolean; acknowledged: boolean }> {
	const alreadyInTranscript = hasPiReportEntry(transport.getEntries(), report.id);

	if (!alreadyInTranscript) {
		transport.sendMessage(
			{
				customType: SUBAGENT_REPORT_TYPE,
				content: `[Subagent ${report.agentName} report]\n${report.text}`,
				display: true,
				details: { reportId: report.id, agentName: report.agentName },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		if (!(await transport.waitForRecorded(report.id))) return { deliveredNow: true, acknowledged: false };
	}

	await acknowledge(report.id);
	return { deliveredNow: !alreadyInTranscript, acknowledged: true };
}
