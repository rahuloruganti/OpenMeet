import { useEffect, useRef, useState } from "react";
import type { AudioHealth, RecordingState } from "../../shared/api/api";
import "./recording-controls.css";

/** The bar says a recording's state in one capitalised word. */
const stateWords: Record<RecordingState["status"], string> = {
  idle: "Ready",
  recording: "Recording",
  paused: "Paused",
  stopped: "Stopped",
};

// Tuning knobs: ~-60 dBFS counts as silence; warn after 10 s of it. Adjust on real devices.
export const SILENT_PEAK = 0.001;
export const SILENT_WARN_MS = 10_000;

/** Maps a linear 0–1 peak to a 0–1 meter value on a -60…0 dBFS scale. */
const meterLevel = (peak: number) =>
  peak > 0 ? Math.min(1, Math.max(0, 1 + Math.log10(peak) / 3)) : 0;

/** "00:12:41"; hours appear from the first hour on. */
export const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

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
  const offset = recording.recording_offset_ms;
  const [elapsed, setElapsed] = useState(offset ?? 0);
  // The backend offset is authoritative; while capturing, the clock advances between events.
  useEffect(() => {
    setElapsed(offset ?? 0);
    if (!capturing || offset === null) return;
    const startedAt = Date.now();
    const timer = setInterval(
      () => setElapsed(offset + (Date.now() - startedAt)),
      500,
    );
    return () => clearInterval(timer);
  }, [capturing, offset]);
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
  const simulated = recording.source !== null && recording.source !== "desktop";
  const label =
    recording.source === null
      ? "Ready"
      : finalizationPending
        ? "Finishing audio…"
        : simulated
          ? `Simulation · ${stateWords[recording.status]}`
          : recording.status === "recording"
            ? "Recording"
            : recording.status === "paused"
              ? "Paused"
              : "Ready";

  return (
    <section
      className={`recording-bar rec${active ? " is-live" : ""}`}
      aria-label="Recording controls"
    >
      <span className="rec-state">
        <span
          className={`status-dot ${simulated ? "simulated" : recording.status}`}
          aria-hidden="true"
        />
        <span className="rec-label" role="status">
          {label}
        </span>
        {active && offset !== null && (
          <span className="rec-timer">{clock(elapsed)}</span>
        )}
      </span>
      {capturing && health && (
        <span className="rec-meters">
          {health.tracks.map((track) => {
            const silent = silentFor[track.kind];
            const warn = silent !== undefined && silent >= SILENT_WARN_MS;
            return (
              <span
                key={track.kind}
                className={warn ? "rec-meter warn" : "rec-meter"}
                role="img"
                aria-label={`${track.kind === "mic" ? "Mic" : "System"}: ${
                  silent === undefined
                    ? "signal"
                    : warn
                      ? `no signal for ${Math.floor(silent / 1000)} s`
                      : "quiet"
                }`}
                title={`${track.kind === "mic" ? "Mic" : "System"}: ${
                  silent === undefined
                    ? "signal"
                    : warn
                      ? `no signal for ${Math.floor(silent / 1000)} s`
                      : "quiet"
                }`}
              >
                <span className="rec-meter-label">
                  {track.kind === "mic" ? "Mic" : "System"}
                </span>
                <span className="rec-meter-bar">
                  <i style={{ width: `${meterLevel(track.peak) * 100}%` }} />
                </span>
              </span>
            );
          })}
        </span>
      )}
      {micSilent && (
        <span className="rec-warn" role="alert">
          No microphone signal. Check the device and its mute.
        </span>
      )}
      <span className="rec-acts">
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
          className={active ? "stop-button rec-stop" : ""}
          disabled={controlsDisabled}
          onClick={props.onStop}
        >
          {finalizationPending ? "Retry finalization" : "Stop"}
        </button>
      </span>
    </section>
  );
}
