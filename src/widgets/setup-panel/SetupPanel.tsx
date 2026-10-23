import type { Ref } from "react";
import type { AudioDevices } from "../../shared/api/api";
import {
  builtinTemplates,
  modeLabels,
  type ProcessingChoice,
} from "../../entities/processing";

type Props = {
  panelRef: Ref<HTMLElement>;
  devices: AudioDevices | null;
  title: string;
  microphone: string;
  output: string;
  disabled: boolean;
  active: boolean;
  onTitle: (value: string) => void;
  onMicrophone: (value: string) => void;
  onOutput: (value: string) => void;
  onRefreshDevices: () => void;
  onClose: () => void;
  processing: ProcessingChoice;
  onOpenSettings: () => void;
  onStartCapture: () => void;
  /** Whether the selected speech engine or API can run now. */
  speechReady: boolean;
  sttMode: "local" | "cloud";
};

export function SetupPanel(props: Props) {
  const { devices, microphone, output, disabled, active } = props;
  const { mode, summary } = props.processing;
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
        Microphone and system audio are saved on this device. Recording is still
        being tested on more computers. Try a short test meeting first.
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
          Selected system audio is unavailable. Choose an available system audio
          device; no device is substituted.
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
            label: "System audio",
            empty: "No system audio selected",
            saved: "Saved system audio (unavailable)",
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
        {summary
          ? `, ${builtinTemplates.find(({ id }) => id === summary)?.label} summary`
          : ""}
        .{" "}
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
      <div className="panel-actions">
        <button
          className="primary"
          disabled={
            disabled ||
            active ||
            !props.title.trim() ||
            !devices?.capture_supported ||
            !microphoneAvailable ||
            !outputAvailable
          }
          onClick={props.onStartCapture}
        >
          Start recording
        </button>
      </div>
    </section>
  );
}
