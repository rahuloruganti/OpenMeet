import { useState, type KeyboardEvent, type Ref } from "react";
import { version } from "../../package.json";
import type {
  AudioDevice,
  AudioDevices,
  ExportOptions,
  KeyStatus,
  MicApp,
  ProviderModel,
  ProviderRole,
  Settings,
  SttDownloadProgress,
  SttStatus,
} from "../lib/api";
import { displayPath, formatBytes } from "../lib/meeting-labels";
import {
  builtinTemplates,
  modeLabels,
  type ProcessingChoice,
} from "../lib/processing";
import { tabTarget } from "../lib/tabs";
import { ModelLibrary } from "./ModelLibrary";
import { Assignment, Connections } from "./ProviderSettings";
import { RecipeSettings } from "./Recipes";
import { SummaryTemplates } from "./SummaryTemplates";
import {
  TranscriptionSettings,
  sttDirty,
  type SttDraft,
} from "./TranscriptionSettings";

export type { SttDraft };

export const settingsSections = [
  ["recording", "Recording"],
  ["transcription", "Transcription"],
  ["ai", "AI notes"],
  ["connections", "Connections"],
  ["models", "Models"],
  ["export", "Export & storage"],
  ["about", "Privacy & about"],
] as const;
export type SettingsSection = (typeof settingsSections)[number][0];

type Props = {
  panelRef: Ref<HTMLElement>;
  settings: Settings | null;
  disabled: boolean;
  shortcut: string;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  onInstallStt: () => void;
  onCancelStt: () => void;
  keyStatus: Record<ProviderRole, KeyStatus>;
  onSettings: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
  onSttMode: (mode: Settings["stt_mode"]) => void;
  onShortcut: (value: string) => void;
  onClose: () => void;
  onChooseFolder: () => void;
  onSaveShortcut: () => void;
  onExportOptions: (options: ExportOptions) => void;
  stopShortcut: string;
  onStopShortcut: (value: string) => void;
  sttDraft: SttDraft;
  onStt: (change: Partial<SttDraft>) => void;
  onSaveStt: () => void;
  onImported: () => Promise<void>;
  processing: ProcessingChoice;
  onProcessing: (choice: ProcessingChoice) => void;
  onSummaryDefault: (template: string) => void;
  devices: AudioDevices | null;
  microphone: string;
  output: string;
  onDefaultDevices: (microphone: string, output: string) => void;
  audioBytes: number | null;
  detectionSupported: boolean;
  onDetection: (enabled: boolean) => void;
  onDetectionIgnored: (app: MicApp, ignored: boolean) => void;
  onRefreshDevices: () => void;
  onRunSetup: () => void;
  initialSection?: SettingsSection;
};

/** A keyboard chord as a shortcut accelerator, or null for a lone modifier or a key without
 * one (a global shortcut on a bare key would capture it system-wide). F-keys may stand alone. */
function accelerator(event: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
  const key =
    event.code === "Space"
      ? "Space"
      : event.code.replace(/^(Key|Digit|Arrow)/, "") || event.key;
  const modified = event.ctrlKey || event.metaKey || event.altKey;
  if (!modified && !/^F\d{1,2}$/.test(key)) return null;
  return [
    (event.ctrlKey || event.metaKey) && "CommandOrControl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

function ShortcutField(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="shortcut-field">
      <label>
        {props.label}
        <input
          value={props.value}
          disabled={props.disabled}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </label>
      <button
        type="button"
        aria-label={`Press keys for ${props.label.toLowerCase()}`}
        disabled={props.disabled}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(event) => {
          // Tab still moves focus, so capturing never traps the keyboard.
          if (!capturing || event.key === "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") return setCapturing(false);
          const chord = accelerator(event);
          if (chord) {
            props.onChange(chord);
            setCapturing(false);
          }
        }}
      >
        {capturing ? "Press a key combination…" : "Press keys…"}
      </button>
    </div>
  );
}

function DeviceSelect(props: {
  label: string;
  value: string;
  devices: AudioDevice[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const missing =
    props.value !== "" && !props.devices.some((d) => d.id === props.value);
  return (
    <label>
      {props.label}
      <select
        value={props.value}
        disabled={props.disabled || props.devices.length === 0}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.value === "" && <option value="">Choose a device</option>}
        {missing && <option value={props.value}>Not connected</option>}
        {props.devices.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SettingsPanel(props: Props) {
  const { settings, disabled } = props;
  const [section, setSection] = useState<SettingsSection>(
    props.initialSection ?? "transcription",
  );
  // Catalog models a scan found on disk but that are not imported yet.
  const [found, setFound] = useState<string[]>([]);
  const [modelsOpened, setModelsOpened] = useState(false);
  const [models, setModels] = useState<{
    connectionId: string;
    models: ProviderModel[];
  } | null>(null);
  const shortcutsDirty =
    !!settings &&
    (props.shortcut !== settings.pause_shortcut ||
      props.stopShortcut !== (settings.stop_shortcut ?? ""));
  const unsaved: Partial<Record<SettingsSection, boolean>> = {
    recording: shortcutsDirty,
    transcription: sttDirty(settings, props.sttDraft),
  };
  const panel = (id: SettingsSection) => ({
    id: `settings-${id}`,
    role: "tabpanel",
    "aria-labelledby": `settings-tab-${id}`,
    hidden: section !== id,
    className: "settings-page",
  });
  const publish = { onSaved: props.onSettings, onKeyStatus: props.onKeyStatus };
  const devices = (microphone: string, output: string) => {
    if (microphone && output) props.onDefaultDevices(microphone, output);
  };
  return (
    <section
      className="workspace-panel settings"
      ref={props.panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="settings-title"
    >
      <div className="panel-heading">
        <h2 id="settings-title">Settings</h2>
        <button aria-label="Close panel" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="settings-layout">
        <div
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          className="settings-nav"
        >
          {settingsSections.map(([id, label], index) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              role="tab"
              aria-selected={section === id}
              aria-controls={`settings-${id}`}
              tabIndex={section === id ? 0 : -1}
              onClick={() => setSection(id)}
              onKeyDown={(event) => {
                if (event.ctrlKey || event.altKey || event.metaKey) return;
                const next = tabTarget(
                  event.key,
                  index,
                  settingsSections.length,
                  true,
                );
                if (next === null) return;
                event.preventDefault();
                const target = settingsSections[next][0];
                setSection(target);
                document.getElementById(`settings-tab-${target}`)?.focus();
              }}
            >
              {label}
              {unsaved[id] && (
                <span className="unsaved-mark" title="Unsaved changes">
                  <span aria-hidden="true"> •</span>
                  <span className="sr-only"> (unsaved changes)</span>
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="settings-pages">
          <div {...panel("recording")}>
            <section className="settings-section" aria-label="Default devices">
              <h3>Default devices</h3>
              <p className="muted">
                New recording starts with these. A device that is not connected
                is never replaced automatically.
              </p>
              <DeviceSelect
                label="Default microphone"
                value={settings?.microphone_id ?? ""}
                devices={props.devices?.microphones ?? []}
                disabled={disabled}
                onChange={(id) =>
                  devices(id, settings?.output_id ?? props.output)
                }
              />
              <DeviceSelect
                label="Default system output"
                value={settings?.output_id ?? ""}
                devices={props.devices?.outputs ?? []}
                disabled={disabled}
                onChange={(id) =>
                  devices(settings?.microphone_id ?? props.microphone, id)
                }
              />
              <button disabled={disabled} onClick={props.onRefreshDevices}>
                Refresh devices
              </button>
            </section>
            <section
              className="settings-section"
              aria-label="Meeting detection"
            >
              <h3>Meeting detection</h3>
              {props.detectionSupported ? (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings?.detection_enabled ?? false}
                      disabled={disabled || !settings}
                      onChange={(event) =>
                        props.onDetection(event.target.checked)
                      }
                    />
                    <span>
                      Offer to record when another app uses the microphone
                    </span>
                  </label>
                  <p className="muted">
                    Every few seconds OpenMeet asks the system which apps are
                    using the microphone. It reads app names only, never audio,
                    and nothing leaves this device. A prompt never starts
                    recording: it opens New recording for you to start.
                  </p>
                  {settings && settings.detection_ignored.length > 0 && (
                    <ul
                      className="ignored-apps"
                      aria-label="Apps never prompted about"
                    >
                      {settings.detection_ignored.map((app) => (
                        <li key={app.id}>
                          <span title={app.id}>{app.name}</span>
                          <button
                            disabled={disabled}
                            onClick={() => props.onDetectionIgnored(app, false)}
                          >
                            Prompt again
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="muted">Not available on this platform yet.</p>
              )}
            </section>
            <section
              className="settings-section"
              aria-label="Keyboard shortcuts"
            >
              <h3>Keyboard shortcuts</h3>
              <ShortcutField
                label="Pause / resume shortcut"
                value={props.shortcut}
                placeholder="CommandOrControl+Shift+Space"
                disabled={disabled}
                onChange={props.onShortcut}
              />
              <ShortcutField
                label="Stop recording shortcut (optional)"
                value={props.stopShortcut}
                placeholder="Leave empty for none"
                disabled={disabled}
                onChange={props.onStopShortcut}
              />
              <p className="muted">
                There is no shortcut to start recording: starting always goes
                through New recording.
              </p>
              {shortcutsDirty && (
                <button
                  disabled={disabled || !props.shortcut.trim()}
                  onClick={props.onSaveShortcut}
                >
                  Save shortcuts
                </button>
              )}
            </section>
          </div>
          <div {...panel("transcription")}>
            <TranscriptionSettings
              settings={settings}
              disabled={disabled}
              stt={props.stt}
              sttProgress={props.sttProgress}
              installing={props.installing}
              found={found}
              models={models}
              sttDraft={props.sttDraft}
              onStt={props.onStt}
              onSaveStt={props.onSaveStt}
              onSttMode={props.onSttMode}
              onInstallStt={props.onInstallStt}
              onCancelStt={props.onCancelStt}
              onSettings={props.onSettings}
              onKeyStatus={props.onKeyStatus}
            />
          </div>
          <div {...panel("ai")}>
            <section
              className="settings-section"
              aria-label="Summaries and questions"
            >
              <h3>Summaries and questions</h3>
              {settings && (
                <Assignment
                  role="llm"
                  settings={settings}
                  disabled={disabled}
                  models={models}
                  {...publish}
                />
              )}
              <label>
                Default summary template
                <select
                  value={settings?.summary_default ?? "general-v1"}
                  disabled={disabled || !settings}
                  onChange={(event) =>
                    props.onSummaryDefault(event.target.value)
                  }
                >
                  {builtinTemplates.map(({ id, label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                  {settings?.summary_templates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section
              className="settings-section"
              aria-label="Automatic processing settings"
            >
              <h3>Automatic processing</h3>
              <label>
                Automatic processing
                <select
                  value={props.processing.mode}
                  disabled={disabled}
                  onChange={(event) =>
                    props.onProcessing({
                      mode: event.target.value as ProcessingChoice["mode"],
                      summary:
                        event.target.value === "final" ||
                        event.target.value === "both"
                          ? props.processing.summary
                          : null,
                    })
                  }
                >
                  {Object.entries(modeLabels).map(([mode, label]) => (
                    <option key={mode} value={mode}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {(props.processing.mode === "final" ||
                props.processing.mode === "both") && (
                <label>
                  Automatic summary
                  <select
                    value={props.processing.summary ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      props.onProcessing({
                        ...props.processing,
                        summary:
                          builtinTemplates.find(
                            ({ id }) => id === event.target.value,
                          )?.id ?? null,
                      })
                    }
                  >
                    <option value="">No automatic summary</option>
                    {builtinTemplates.map(({ id, label }) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="muted">
                Runs after every recording. Audio and text go to the engines and
                connections set in Transcription and AI notes. If they are not
                ready, the recording is still kept and processing is skipped
                with a notice.
              </p>
            </section>
            <SummaryTemplates
              settings={settings}
              disabled={disabled}
              onSettings={props.onSettings}
            />
            <RecipeSettings
              settings={settings}
              disabled={disabled}
              onSettings={props.onSettings}
            />
          </div>
          <div {...panel("connections")}>
            {settings && (
              <Connections
                settings={settings}
                active={section === "connections"}
                disabled={disabled}
                onModels={(connectionId, list) =>
                  setModels({ connectionId, models: list })
                }
                {...publish}
              />
            )}
          </div>
          <div {...panel("models")}>
            <details
              className="settings-section advanced"
              onToggle={(event) => {
                if (event.currentTarget.open) setModelsOpened(true);
              }}
            >
              <summary>Advanced: local model library</summary>
              {/* Mounted on first expand: it scans on mount, and a failure must be visible. */}
              {modelsOpened && (
                <ModelLibrary
                  disabled={disabled}
                  onImported={props.onImported}
                  onFound={setFound}
                  onUse={(path) => props.onStt({ stt_model: path })}
                />
              )}
            </details>
          </div>
          <div {...panel("export")}>
            <section
              className="settings-section"
              aria-label="Storage and export settings"
            >
              <h3>Storage & export</h3>
              <label>
                Export folder
                <output>
                  {settings?.vault_folder
                    ? displayPath(settings.vault_folder)
                    : "Not selected"}
                </output>
              </label>
              <button disabled={disabled} onClick={props.onChooseFolder}>
                Choose export folder
              </button>
              <p className="muted">
                Audio recordings use{" "}
                {props.audioBytes === null
                  ? "an unknown amount of space"
                  : formatBytes(props.audioBytes)}{" "}
                on this device. Notes, audio and exports are unencrypted.
              </p>
            </section>
            {settings && (
              <fieldset
                className="export-options settings-section"
                disabled={disabled}
              >
                <legend>Markdown export</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.export.summary}
                    onChange={(event) =>
                      props.onExportOptions({
                        ...settings.export,
                        summary: event.target.checked,
                      })
                    }
                  />
                  Include summary
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.export.transcript}
                    onChange={(event) =>
                      props.onExportOptions({
                        ...settings.export,
                        transcript: event.target.checked,
                      })
                    }
                  />
                  Include transcript
                </label>
                <label>
                  File name
                  <select
                    value={settings.export.filename}
                    onChange={(event) =>
                      props.onExportOptions({
                        ...settings.export,
                        filename:
                          event.target.value === "date_title"
                            ? "date_title"
                            : "title",
                      })
                    }
                  >
                    <option value="title">Meeting title</option>
                    <option value="date_title">Date, then meeting title</option>
                  </select>
                </label>
                <fieldset disabled={disabled}>
                  <legend>Transcript files</legend>
                  {(["txt", "srt", "vtt"] as const).map((format) => (
                    <label key={format}>
                      <input
                        type="checkbox"
                        checked={settings.export.transcript_formats.includes(
                          format,
                        )}
                        onChange={(event) =>
                          props.onExportOptions({
                            ...settings.export,
                            transcript_formats: event.target.checked
                              ? [...settings.export.transcript_formats, format]
                              : settings.export.transcript_formats.filter(
                                  (chosen) => chosen !== format,
                                ),
                          })
                        }
                      />
                      {format === "txt"
                        ? "Plain text (.txt)"
                        : format === "srt"
                          ? "Subtitles (.srt)"
                          : "WebVTT (.vtt)"}
                    </label>
                  ))}
                  <p className="muted">
                    Written next to the Markdown snapshot with the same name.
                    SRT and VTT need engine timestamps, so a meeting with
                    untimed segments cannot be exported while either is
                    selected.
                  </p>
                </fieldset>
                <p className="muted">
                  Applies to new exports. Earlier snapshots are never renamed or
                  overwritten.
                </p>
              </fieldset>
            )}
          </div>
          <div {...panel("about")}>
            <section className="settings-section" aria-label="Privacy">
              <h3>What leaves this device</h3>
              <ul className="privacy-list">
                <li>
                  <strong>Recording and local transcription:</strong> nothing.
                  Audio, notes and transcripts are stored here, unencrypted.
                </li>
                <li>
                  <strong>API transcription:</strong> recorded audio, sent to
                  your speech connection when you transcribe.
                </li>
                <li>
                  <strong>Summaries, questions and rewrites:</strong> notes,
                  transcript text or the selected text, sent to your AI notes
                  connection when you use them.
                </li>
                <li>
                  <strong>Meeting detection (off by default):</strong> reads
                  which apps use the microphone, on this device only.
                </li>
                <li>
                  <strong>Model downloads:</strong> requests to github.com and
                  huggingface.co. No meeting content.
                </li>
                <li>
                  <strong>Exports:</strong> files in your export folder, which
                  may itself be synced by other software.
                </li>
              </ul>
              <p className="muted">
                Connections marked "This device" use a local server; its own
                configuration decides whether it forwards requests. API keys are
                kept in the OS keychain.
              </p>
            </section>
            <section className="settings-section" aria-label="About">
              <h3>About OpenMeet</h3>
              <p>Version {version} (preview)</p>
              <button disabled={props.disabled} onClick={props.onRunSetup}>
                Run setup again
              </button>
              <p className="muted">
                Capture is not yet hardware-qualified. Third-party licenses are
                listed in THIRD_PARTY_LICENSES.md in the source repository.
              </p>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
