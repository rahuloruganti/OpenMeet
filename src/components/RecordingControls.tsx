import type { RecordingState } from "../lib/api";

type Props = {
  recording: RecordingState;
  active: boolean;
  ready: boolean;
  controlBusy: boolean;
  disabled: boolean;
  showOpenActive: boolean;
  onOpenActive: () => void;
  onToggle: () => void;
  onStop: () => void;
};

export function RecordingControls(props: Props) {
  const { recording, active } = props;
  const controlsDisabled = !props.ready || props.controlBusy || !active;
  return (
    <section className="recording-bar" aria-label="Recording controls">
      <div className="recording-indicator">
        <span className={`status-dot ${recording.status}`} aria-hidden="true" />
        <span className={`recording-state ${recording.status}`} role="status">
          {recording.source === null
            ? "Not recording"
            : `${recording.source === "desktop" ? "Recording" : "Simulation"}: ${recording.status}`}
        </span>
      </div>
      <div className="actions">
        {props.showOpenActive && (
          <button disabled={props.disabled} onClick={props.onOpenActive}>
            Open active meeting
          </button>
        )}
        <button disabled={controlsDisabled} onClick={props.onToggle}>
          {recording.status === "paused" ? "Resume" : "Pause"}
        </button>
        <button disabled={controlsDisabled} onClick={props.onStop}>
          Stop
        </button>
      </div>
    </section>
  );
}
