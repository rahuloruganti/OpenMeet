import { formatBytes } from "../../../entities/meeting";
import { stageLabel } from "../../../entities/processing";
import { formatTimestamp } from "../../../shared/lib/timestamps";
import type { SessionProcessingSnapshot } from "../../../shared/api/api";
import { awaitingNotes, endedStages, retryStages } from "../model/processing";

/** Session processing progress, its controls, and a provisional live transcript. */
export function ProcessingPanel(props: {
  processing: SessionProcessingSnapshot;
  busy: boolean;
  active: boolean;
  ackError: { meetingId: string; message: string } | null;
  onAcknowledgeNotes: (retry: boolean) => void;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { processing, busy, active } = props;
  const stage = processing.workflow?.stage ?? processing.state;
  return (
    <section className="processing-panel" aria-label="Session processing">
      <h3>Automatic processing</h3>
      <p role="status">Stage: {stageLabel(stage)}</p>
      {processing.workflow?.error && (
        <p role="alert">{processing.workflow.error}</p>
      )}
      {processing.workflow?.live_incomplete && (
        <p role="status">
          Live transcript is incomplete. Recorded audio is preserved for final
          transcription.
        </p>
      )}
      {processing.workflow &&
        (processing.workflow.requests_used > 0 ||
          processing.workflow.upload_bytes_used > 0 ||
          processing.workflow.text_bytes_used > 0) && (
          <p>
            Used {processing.workflow.requests_used}{" "}
            {processing.workflow.requests_used === 1 ? "request" : "requests"},{" "}
            {formatBytes(processing.workflow.upload_bytes_used)} of audio and{" "}
            {formatBytes(processing.workflow.text_bytes_used)} of text.
          </p>
        )}
      {awaitingNotes(processing) && (
        <div>
          <p>
            Automatic summary waits for saved notes.
            {props.ackError?.meetingId === processing.meeting_id &&
              ` Notes acknowledgement failed: ${props.ackError.message}`}
          </p>
          <button
            disabled={busy}
            onClick={() => props.onAcknowledgeNotes(true)}
          >
            Save notes and continue processing
          </button>
        </div>
      )}
      {!endedStages.includes(stage) && (
        <button disabled={busy} onClick={props.onCancel}>
          Cancel session processing
        </button>
      )}
      {retryStages.includes(stage) && (
        <button disabled={busy || active} onClick={props.onRetry}>
          Retry processing
        </button>
      )}
      {!!processing.workflow?.provisional.length && (
        <section aria-label="Provisional live transcript">
          <h4>Provisional live transcript</h4>
          <p>
            Latest 200 segments. Excluded from search, export and summaries
            until final transcription.
          </p>
          {Array.from(
            new Map(
              processing.workflow.provisional.map((row) => [row.id, row]),
            ).values(),
          )
            .slice(-200)
            .map((row) => (
              <p key={row.id}>
                {row.segment.timing.kind === "timed"
                  ? `${formatTimestamp(row.segment.timing.start_ms)} `
                  : "[Untimed] "}
                <strong>{row.segment.speaker}:</strong>{" "}
                <span>{row.segment.text}</span>
              </p>
            ))}
        </section>
      )}
      {["completed", "cancelled"].includes(stage) && (
        <button
          aria-label="Dismiss processing status"
          onClick={props.onDismiss}
        >
          Dismiss
        </button>
      )}
    </section>
  );
}
