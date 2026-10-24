import { formatBytes } from "../../../entities/meeting";
import { stageLabel } from "../../../entities/processing";
import type { SessionProcessingSnapshot } from "../../../shared/api/api";
import { awaitingNotes, endedStages, retryStages } from "../model/processing";

/**
 * Session processing as ONE status line above the editor: what runs now, why it
 * stopped, and the single action that helps. Usage details sit beside it in muted text.
 */
export function ProcessingStatus(props: {
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
  const workflow = processing.workflow;
  const stage = workflow?.stage ?? processing.state;
  const waiting = awaitingNotes(processing);
  const ended = endedStages.includes(stage);
  const retry = retryStages.includes(stage);
  const ackFailed =
    props.ackError?.meetingId === processing.meeting_id
      ? props.ackError.message
      : null;
  const details = [
    workflow?.live_incomplete
      ? "The live transcript is incomplete; recorded audio is kept for final transcription."
      : "",
    workflow && workflow.requests_used > 0
      ? `Used ${workflow.requests_used} request${workflow.requests_used === 1 ? "" : "s"}, ${formatBytes(workflow.upload_bytes_used)} of audio and ${formatBytes(workflow.text_bytes_used)} of text.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className="proc" aria-label="Session processing">
      <span className={`proc-dot ${stage}`} aria-hidden="true" />
      <span className="proc-text" role="status">
        {stageLabel(stage)}
        {waiting ? " · waiting for notes" : ""}
        {retry && workflow?.error ? `: ${workflow.error}` : ""}
        {ackFailed ? `: ${ackFailed}` : ""}
      </span>
      {details && <span className="proc-detail">{details}</span>}
      <span className="proc-acts">
        {waiting && (
          <button
            aria-label="Save notes and continue processing"
            disabled={busy}
            onClick={() => props.onAcknowledgeNotes(true)}
          >
            Save notes
          </button>
        )}
        {!ended && (
          <button
            aria-label="Cancel session processing"
            disabled={busy}
            onClick={props.onCancel}
          >
            Cancel
          </button>
        )}
        {retry && (
          <button
            aria-label="Retry processing"
            disabled={busy || active}
            onClick={props.onRetry}
          >
            Retry
          </button>
        )}
        {["completed", "cancelled"].includes(stage) && (
          <button
            aria-label="Dismiss processing status"
            onClick={props.onDismiss}
          >
            ✕
          </button>
        )}
      </span>
    </section>
  );
}
