import type {
  MicApp,
  SessionProcessingSnapshot,
} from "../../../shared/api/api";

export type FeedbackProps = {
  desktop: boolean;
  ready: boolean;
  busy: boolean;
  active: boolean;
  disabled: boolean;
  detectedApp: MicApp | undefined;
  notesError: string;
  notesErrorReason: string;
  error: string;
  captureError: string | null;
  processingNotice: string | null;
  notice: string;
  gapNotice: string;
  healthError: string | null;
  /** Rendered as one line by the workspace, not here. */
  processing: SessionProcessingSnapshot | null;
  ackError: { meetingId: string; message: string } | null;
  onSetupDetected: (trigger: HTMLButtonElement) => void;
  onDismissDetected: () => void;
  onIgnoreDetected: () => void;
  onDismissError: () => void;
  onDismissCapture: () => void;
  onDismissNotice: () => void;
  onDismissGaps: () => void;
  onAcknowledgeNotes: (retry: boolean) => void;
  onCancelProcessing: () => void;
  onRetryProcessing: () => void;
  onDismissProcessing: () => void;
};

/** Banners above the document: detection, errors, notices and audio gaps. */
export function FeedbackStack(props: FeedbackProps) {
  return (
    <div className="feedback-stack">
      {props.detectedApp && (
        <div
          className="detection-card"
          role="status"
          aria-label="Meeting detected"
        >
          <span>
            <strong>{props.detectedApp.name}</strong> is using your microphone.
            Record this meeting?
          </span>
          <div className="panel-actions">
            <button
              className="primary"
              disabled={props.disabled}
              onClick={(event) => props.onSetupDetected(event.currentTarget)}
            >
              Set up recording
            </button>
            <button onClick={props.onDismissDetected}>Not now</button>
            <button onClick={props.onIgnoreDetected}>
              Never for {props.detectedApp.name}
            </button>
          </div>
        </div>
      )}
      {!props.desktop && (
        <p role="alert">
          The browser preview has no database. Start OpenMeet with{" "}
          <code>just dev</code> or the OpenMeet.exe build.
        </p>
      )}
      {/* Above the action errors, which point at it ("Fix the problem above"). */}
      {props.notesError && (
        <p className="error" role="alert">
          Notes not saved: {props.notesErrorReason}. You can't switch meetings
          until this is fixed. Copy your text or retry.
        </p>
      )}
      {props.error && (
        <div className="error" role="alert">
          {props.error} <button onClick={props.onDismissError}>Dismiss</button>
        </div>
      )}
      {props.captureError && (
        <div className="error" role="alert">
          <span>Capture: {props.captureError}</span>{" "}
          <button
            aria-label="Dismiss capture error"
            onClick={props.onDismissCapture}
          >
            Dismiss
          </button>
        </div>
      )}
      {props.processingNotice && (
        <p className="notice" role="status">
          {props.processingNotice}
        </p>
      )}
      {props.notice && (
        <div className="notice" role="status">
          <span>{props.notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={props.onDismissNotice}
          >
            Dismiss
          </button>
        </div>
      )}
      {props.desktop && !props.ready && !props.error && (
        <p role="status">Opening local database…</p>
      )}
      {props.gapNotice && (
        <div className="notice" role="status">
          <span>{props.gapNotice}</span>
          <button
            aria-label="Dismiss audio gap notice"
            onClick={props.onDismissGaps}
          >
            Dismiss
          </button>
        </div>
      )}
      {props.active && props.healthError && (
        <p className="error" role="alert">
          Audio: {props.healthError}
        </p>
      )}
    </div>
  );
}
