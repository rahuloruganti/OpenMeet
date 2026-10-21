import { useEffect, useRef, useState, type Ref } from "react";
import {
  api,
  errorMessage,
  type AudioDevices,
  type SessionProcessingPlan,
  type SessionProcessingRequest,
} from "../lib/api";
import type { ProcessingChoice } from "../lib/processing";
import { SessionReview } from "./SessionReview";

type Props = {
  panelRef: Ref<HTMLElement>;
  devices: AudioDevices | null;
  title: string;
  consent: boolean;
  microphone: string;
  output: string;
  disabled: boolean;
  active: boolean;
  onTitle: (value: string) => void;
  onConsent: (value: boolean) => void;
  onMicrophone: (value: string) => void;
  onOutput: (value: string) => void;
  onRefreshDevices: () => void;
  onClose: () => void;
  configurationRevision: string;
  processing: ProcessingChoice;
  onOpenSettings: () => void;
  onStartCapture: (confirmation: string | null) => void;
  /** Whether the selected speech engine or API can run now. */
  speechReady: boolean;
  sttMode: "local" | "cloud";
};

const modeLabels = {
  recording: "Recording only",
  live: "Live transcription only",
  final: "Final transcription after stop",
  both: "Live and final transcription",
} as const;
const templateLabels = {
  "general-v1": "General",
  "standup-v1": "Stand-up",
  "one-to-one-v1": "One-to-one",
} as const;

export function SetupPanel(props: Props) {
  const { devices, microphone, output, disabled, active } = props;
  const { mode, summary } = props.processing;
  const [plan, setPlan] = useState<SessionProcessingPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const reviewVersion = useRef(0);
  useEffect(() => {
    reviewVersion.current += 1;
    setPlan(null);
    setConfirmed(false);
  }, [mode, summary, props.configurationRevision, microphone, output]);
  const review = async () => {
    const version = ++reviewVersion.current;
    setReviewing(true);
    setError("");
    try {
      const request: SessionProcessingRequest =
        mode === "live"
          ? { kind: "live_only" }
          : { kind: "final", live: mode === "both", summary };
      const result = await api.prepareSessionProcessing(request);
      if (reviewVersion.current === version) {
        setPlan(result);
        setConfirmed(false);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setReviewing(false);
    }
  };
  const microphoneAvailable =
    devices?.microphones.some((device) => device.id === microphone) ?? false;
  const outputAvailable =
    devices?.outputs.some((device) => device.id === output) ?? false;

  return (
    <section
      className="workspace-panel setup"
      ref={props.panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="setup-title"
    >
      <div className="panel-heading">
        <h2 id="setup-title">New recording</h2>
        <button aria-label="Close panel" onClick={props.onClose}>
          Close
        </button>
      </div>
      <p className="panel-description">
        Microphone and system audio are saved on this device. Capture is a
        preview; hardware qualification is pending.
      </p>
      {devices && !devices.capture_supported && (
        <p role="alert">
          Recording needs Windows, or Apple Silicon on macOS 14.2 or newer.
        </p>
      )}
      {!microphoneAvailable && (
        <p role="alert">
          Selected microphone is unavailable. Connect or allow it and press
          Refresh devices, or choose an available microphone; no device is
          substituted.
        </p>
      )}
      {!outputAvailable && (
        <p role="alert">
          Selected system output is unavailable. Choose an available output; no
          device is substituted.
        </p>
      )}
      <label>
        Meeting title
        <input
          value={props.title}
          maxLength={160}
          disabled={disabled || active}
          onChange={(event) => props.onTitle(event.target.value)}
        />
      </label>
      <div className="field-row">
        {[
          {
            label: "Microphone",
            empty: "No microphone selected",
            saved: "Saved microphone (unavailable)",
            value: microphone,
            available: microphoneAvailable,
            options: devices?.microphones,
            onChange: props.onMicrophone,
          },
          {
            label: "System output",
            empty: "No system output selected",
            saved: "Saved system output (unavailable)",
            value: output,
            available: outputAvailable,
            options: devices?.outputs,
            onChange: props.onOutput,
          },
        ].map((field) => (
          <label key={field.label}>
            {field.label}
            <select
              value={field.value}
              disabled={disabled || active || !devices?.capture_supported}
              onChange={(event) => field.onChange(event.target.value)}
            >
              {!field.value && <option value="">{field.empty}</option>}
              {field.value && !field.available && (
                <option value={field.value} disabled>
                  {field.saved}
                </option>
              )}
              {field.options?.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button disabled={disabled || active} onClick={props.onRefreshDevices}>
        Refresh devices
      </button>
      <p>
        Automatic processing: <strong>{modeLabels[mode]}</strong>
        {summary ? `, ${templateLabels[summary]} summary` : ""}.{" "}
        <button type="button" onClick={props.onOpenSettings}>
          Change in Settings
        </button>
      </p>
      {mode !== "recording" && !props.speechReady && (
        <p role="alert" className="error">
          {props.sttMode === "cloud"
            ? "No cloud speech connection and model are ready."
            : "The local speech engine is not downloaded."}{" "}
          Transcription for this recording will fail until you set it up in
          Settings. The recording itself is still kept.
        </p>
      )}
      {mode !== "recording" && (
        <button
          disabled={disabled || active || reviewing}
          onClick={() => void review()}
        >
          Review processing
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {mode !== "recording" && plan && (
        <SessionReview
          plan={plan}
          confirmed={confirmed}
          onConfirm={setConfirmed}
        />
      )}
      <label className="check consent-check">
        <input
          type="checkbox"
          checked={props.consent}
          disabled={disabled || active}
          onChange={(event) => props.onConsent(event.target.checked)}
        />
        <span>
          I have informed participants and have consent to record microphone and
          system audio.
        </span>
      </label>
      <div className="panel-actions">
        <button
          className="primary"
          disabled={
            disabled ||
            active ||
            !props.consent ||
            !props.title.trim() ||
            !devices?.capture_supported ||
            !microphoneAvailable ||
            !outputAvailable ||
            (mode !== "recording" &&
              (!plan ||
                !confirmed ||
                plan.review_expires_at <= Date.now() / 1000))
          }
          onClick={() =>
            props.onStartCapture(
              mode === "recording"
                ? null
                : plan && confirmed
                  ? plan.fingerprint
                  : null,
            )
          }
        >
          Start recording
        </button>
      </div>
    </section>
  );
}
