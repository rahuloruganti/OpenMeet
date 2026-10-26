import type {
  MicApp,
  SessionProcessingSnapshot,
} from "../../../shared/api/api";
import { IconAlert, IconInfo, IconMic } from "../../../shared/ui/icons";

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

/** Banners above the document: detection, errors, notices and audio gaps.
 * Each is one raised row with a leading icon; the tint carries the meaning. */
export function FeedbackStack(props: FeedbackProps) {
  return (
    <div className="feedback-stack">
      {props.detectedApp && (
        <div
          className="detection-card"
          role="status"
          aria-label="Meeting detected"
        >
          <IconMic className="banner-icon" />
          <span className="banner-text">
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
            <button className="ghost" onClick={props.onDismissDetected}>
              Not now
            </button>
            <button className="ghost" onClick={props.onIgnoreDetected}>
              Never for {props.detectedApp.name}
            </button>
          </div>
        </div>
      )}
      {!props.desktop && (
        <div className="error" role="alert">
          <IconAlert className="banner-icon" />
          <span className="banner-text">
            The browser preview has no database. Start OpenMeet with{" "}
            <code>just dev</code> or the OpenMeet.exe build.
          </span>
        </div>
      )}
      {/* Above the action errors, which point at it ("Fix the problem above"). */}
      {props.notesError && (
        <div className="error" role="alert">
          <IconAlert className="banner-icon" />
          <span className="banner-text">
            Notes not saved: {props.notesErrorReason}. You can't switch meetings
            until this is fixed. Copy your text or retry.
          </span>
        </div>
      )}
      {props.error && (
        <div className="error" role="alert">
          <IconAlert className="banner-icon" />
          <span className="banner-text">{props.error}</span>
          <button className="ghost" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      )}
      {props.captureError && (
        <div className="error" role="alert">
          <IconAlert className="banner-icon" />
          <span className="banner-text">Capture: {props.captureError}</span>
          <button
            className="ghost"
            aria-label="Dismiss capture error"
            onClick={props.onDismissCapture}
          >
            Dismiss
          </button>
        </div>
      )}
      {props.processingNotice && (
        <div className="notice" role="status">
          <IconInfo className="banner-icon" />
          <span className="banner-text">{props.processingNotice}</span>
        </div>
      )}
      {props.notice && (
        <div className="notice" role="status">
          <IconInfo className="banner-icon" />
          <span className="banner-text">{props.notice}</span>
          <button
            className="ghost"
            aria-label="Dismiss notification"
            onClick={props.onDismissNotice}
          >
            Dismiss
          </button>
        </div>
      )}
      {props.desktop && !props.ready && !props.error && (
        <p className="banner-quiet" role="status">
          Opening local database…
        </p>
      )}
      {props.gapNotice && (
        <div className="notice" role="status">
          <IconInfo className="banner-icon" />
          <span className="banner-text">{props.gapNotice}</span>
          <button
            className="ghost"
            aria-label="Dismiss audio gap notice"
            onClick={props.onDismissGaps}
          >
            Dismiss
          </button>
        </div>
      )}
      {props.active && props.healthError && (
        <div className="error" role="alert">
          <IconAlert className="banner-icon" />
          <span className="banner-text">Audio: {props.healthError}</span>
        </div>
      )}
    </div>
  );
}
