import { useEffect, useRef, useState } from "react";
import type { AudioHealth, RecordingState } from "../lib/api";

// Tuning knobs: ~-60 dBFS counts as silence; warn after 10 s of it. Adjust on real devices.
export const SILENT_PEAK = 0.001;
export const SILENT_WARN_MS = 10_000;

/** Maps a linear 0–1 peak to a 0–1 meter value on a -60…0 dBFS scale. */
const meterLevel = (peak: number) =>
  peak > 0 ? Math.min(1, Math.max(0, 1 + Math.log10(peak) / 3)) : 0;

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
  health: AudioHealth | null;
};

export function RecordingControls(props: Props) {
  const { recording, active, health } = props;
  const controlsDisabled = !props.ready || props.controlBusy || !active;
  const finalizationPending =
    recording.status === "paused" &&
    recording.source === "desktop" &&
    recording.recording_offset_ms === null;
  const capturing =
    recording.status === "recording" && recording.source === "desktop";
  // When each track's signal went silent; only counted while actually recording.
  const silentSince = useRef<Record<string, number>>({});
  const [silentFor, setSilentFor] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!capturing || !health) {
      silentSince.current = {};
      setSilentFor({});
      return;
    }
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const track of health.tracks) {
      if (track.peak < SILENT_PEAK) {
        silentSince.current[track.kind] ??= now;
        next[track.kind] = now - silentSince.current[track.kind];
      } else delete silentSince.current[track.kind];
    }
    setSilentFor(next);
  }, [capturing, health]);
  const micSilent = (silentFor.mic ?? 0) >= SILENT_WARN_MS;

  return (
    <section
      className={`recording-bar${active ? " is-active" : ""}`}
      aria-label="Recording controls"
    >
      <div className="recording-indicator">
        <span className={`status-dot ${recording.status}`} aria-hidden="true" />
        <span className={`recording-state ${recording.status}`} role="status">
          {recording.source === null
            ? "Not recording"
            : finalizationPending
              ? "Audio stopped; finalization pending"
              : recording.source === "desktop" &&
                  recording.status === "recording"
                ? "Recording"
                : `${recording.source === "desktop" ? "Recording" : "Simulation"}: ${recording.status}`}
        </span>
      </div>
      {capturing && health && (
        <div className="level-meters">
          {health.tracks.map((track) => {
            const silent = silentFor[track.kind];
            const state =
              silent === undefined
                ? "signal"
                : silent >= SILENT_WARN_MS
                  ? `no signal for ${Math.floor(silent / 1000)} s`
                  : "quiet";
            return (
              <label
                key={track.kind}
                className={`level-meter${state.startsWith("no signal") ? " warn" : ""}`}
              >
                <span>
                  {track.kind === "mic" ? "Mic" : "System"}: {state}
                </span>
                <meter min={0} max={1} value={meterLevel(track.peak)} />
              </label>
            );
          })}
        </div>
      )}
      {micSilent && (
        <p className="error" role="alert">
          The microphone has had no signal for at least {SILENT_WARN_MS / 1000}{" "}
          seconds. Check that the right microphone is selected and not muted.
        </p>
      )}
      <div className="actions">
        {props.showOpenActive && (
          <button disabled={props.disabled} onClick={props.onOpenActive}>
            Open active meeting
          </button>
        )}
        <button
          disabled={controlsDisabled || finalizationPending}
          onClick={props.onToggle}
        >
          {recording.status === "paused" ? "Resume" : "Pause"}
        </button>
        <button
          className={active ? "stop-button" : ""}
          disabled={controlsDisabled}
          onClick={props.onStop}
        >
          {finalizationPending ? "Retry finalization" : "Stop"}
        </button>
      </div>
    </section>
  );
}
