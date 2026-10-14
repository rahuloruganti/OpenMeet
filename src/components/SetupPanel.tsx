import type { Ref } from "react";
import type { AudioDevices } from "../lib/api";

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
  onClose: () => void;
  onStartCapture: () => void;
};

export function SetupPanel(props: Props) {
  const { devices, microphone, output, disabled, active } = props;
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
          Selected microphone is unavailable. Choose an available microphone; no
          device is substituted.
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
