import { useEffect, useRef, type KeyboardEvent, type Ref } from "react";
import type { AudioDevices } from "../../shared/api/api";
import {
  builtinTemplates,
  modeLabels,
  type ProcessingChoice,
} from "../../entities/processing";
import "./setup-panel.css";

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

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** New recording: a dialog over the meeting page. Esc and Cancel close it. */
export function SetupPanel(props: Props) {
  const { devices, microphone, output, disabled, active } = props;
  const { mode, summary } = props.processing;
  const dialog = useRef<HTMLElement | null>(null);
  const microphoneAvailable =
    devices?.microphones.some((device) => device.id === microphone) ?? false;
  const outputAvailable =
    devices?.outputs.some((device) => device.id === output) ?? false;
  const attach = (node: HTMLElement | null) => {
    dialog.current = node;
    if (typeof props.panelRef === "function") props.panelRef(node);
    else if (props.panelRef)
      (props.panelRef as { current: HTMLElement | null }).current = node;
  };
  // Focus starts inside the dialog, so Escape and Tab reach it before the page.
  useEffect(() => {
    const node = dialog.current;
    if (!node || node.contains(document.activeElement)) return;
    node.querySelector<HTMLElement>("input, select, button")?.focus();
  }, []);
  // Tab stays inside the dialog; Escape closes it before the page sees the key.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>(focusable) ?? [],
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const startDisabled =
    disabled ||
    active ||
    !props.title.trim() ||
    !devices?.capture_supported ||
    !microphoneAvailable ||
    !outputAvailable;

  return (
    <div
      className="setup-veil"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        className="setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        ref={attach}
        onKeyDown={onKeyDown}
      >
        <header className="setup-head">
          <h2 id="setup-title">New recording</h2>
          <span className="setup-gap" />
          <button aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="setup-body">
          <label className="setup-field">
            <span className="setup-label">Title</span>
            <input
              value={props.title}
              maxLength={160}
              disabled={disabled || active}
              onChange={(event) => props.onTitle(event.target.value)}
            />
          </label>
          <div className="setup-pair">
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
              <label className="setup-field" key={field.label}>
                <span className="setup-label">{field.label}</span>
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
          <p className="setup-hint">Audio stays on this device.</p>
          {devices && !devices.capture_supported && (
            <p role="alert" className="setup-alert">
              Recording needs Windows.
            </p>
          )}
          {!microphoneAvailable && (
            <p role="alert" className="setup-alert">
              That microphone is unavailable. Pick another one.
            </p>
          )}
          {!outputAvailable && (
            <p role="alert" className="setup-alert">
              That system audio device is unavailable. Pick another one.
            </p>
          )}
          <details className="setup-more">
            <summary>More options</summary>
            <div className="setup-more-body">
              <div className="setup-row">
                <button
                  type="button"
                  disabled={disabled || active}
                  onClick={props.onRefreshDevices}
                >
                  Refresh devices
                </button>
                <span className="setup-hint">
                  {modeLabels[mode]}
                  {summary
                    ? ` · ${builtinTemplates.find(({ id }) => id === summary)?.label} summary`
                    : ""}
                </span>
                <button type="button" onClick={props.onOpenSettings}>
                  Open Settings
                </button>
              </div>
              {mode !== "recording" && !props.speechReady && (
                <p role="alert" className="setup-alert">
                  {props.sttMode === "cloud"
                    ? "No cloud speech connection is ready."
                    : "The speech engine is not downloaded."}{" "}
                  Recording is kept; transcription fails until it is set up.
                </p>
              )}
            </div>
          </details>
        </div>
        <footer className="setup-foot">
          <button onClick={props.onClose}>Cancel</button>
          <button
            className="primary"
            disabled={startDisabled}
            onClick={props.onStartCapture}
          >
            Start recording
          </button>
        </footer>
      </section>
    </div>
  );
}
