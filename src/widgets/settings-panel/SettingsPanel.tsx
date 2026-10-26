import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { version } from "../../../package.json";
import { api, isLocalBase } from "../../shared/api/api";
import type {
  AudioDevice,
  AudioDevices,
  ExportOptions,
  KeyStatus,
  LocalModel,
  MicApp,
  ModelScan,
  ProviderRole,
  Settings,
  SttDownloadProgress,
  SttStatus,
  Theme,
} from "../../shared/api/api";
import { displayPath, formatBytes } from "../../entities/meeting";
import {
  builtinTemplates,
  modeLabels,
  type ProcessingChoice,
} from "../../entities/processing";
import { shortcutLabel } from "../../shared/lib/shortcut-label";
import { ModelLibrary } from "../../features/model-library";
import { LocalAi } from "../../features/local-ai";
import { CalendarSettings } from "../../features/calendar";
import { LiveSettings } from "../../features/live-settings";
import { ConnectionEditor } from "../../features/provider-settings";
import { SummaryTemplates } from "../../features/summary-templates";
import { TranscriptionSettings } from "../../features/transcription-settings";
import { hostOf } from "../../shared/ui/provider-connection";
import {
  OpenSettingsButton,
  resolveSettingsSection,
  Saved,
  settingsSections,
  useSaved,
  type AiBlock,
  type OpenSettings,
  type SettingsSection,
  type SettingsSectionId,
} from "../../shared/ui/settings-link";
import "./ui/settings-page.css";
import { CardFoot, Group, More, Row, Rows, Segmented, Switch } from "./ui/rows";
import type { Segment } from "./ui/rows";

export { OpenSettingsButton, settingsSections };
export type { AiBlock, OpenSettings, SettingsSection };

type Props = {
  settings: Settings | null;
  disabled: boolean;
  /** Focus hand-back target for the shell; a full page does not need one. */
  panelRef?: Ref<HTMLElement>;
  /**
   * The visible section. Pass it with `onSection` to control the panel (the settings page does);
   * without it the panel keeps the section itself.
   */
  section?: SettingsSection;
  /** Called with the visible id when the section list is used. */
  onSection?: (section: SettingsSectionId) => void;
  /** Section to open before `section` is controlled; old ids are aliases. */
  initialSection?: SettingsSection;
  /** Shown in the header and Privacy & about; defaults to the app version. */
  version?: string;
  /** Saves the colour theme through api.saveUiPrefs. */
  onTheme?: (theme: Theme) => void;
  devices: AudioDevices | null;
  microphone: string;
  output: string;
  onDefaultDevices: (microphone: string, output: string) => void;
  onRefreshDevices: () => void;
  /** Saves both global shortcuts; an empty stop shortcut clears it. */
  onSaveShortcuts: (pause: string, stop: string) => void;
  processing: ProcessingChoice;
  onProcessing: (choice: ProcessingChoice) => void;
  detectionSupported: boolean;
  onDetection: (enabled: boolean) => void;
  /** Saves the automatic capture switch; only reachable while meeting detection is on. */
  onAutoCapture: (enabled: boolean) => void;
  onDetectionIgnored: (app: MicApp, ignored: boolean) => void;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  onInstallStt: () => void;
  /** Saves a catalog model as the speech model, then downloads it. */
  onDownloadStt?: (change: {
    stt_language: string;
    stt_prompt: string;
    stt_model: string;
  }) => void;
  onCancelStt: () => void;
  onSttMode: (mode: Settings["stt_mode"]) => void;
  /** Saves a transcription change (language, vocabulary hint or model) immediately. */
  onSaveStt: (change: {
    stt_language: string;
    stt_prompt: string;
    stt_model: string;
  }) => void;
  onImported: () => Promise<void>;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
  onSettings: (settings: Settings) => void;
  onSummaryDefault: (template: string) => void;
  onChooseFolder: () => void;
  onExportOptions: (options: ExportOptions) => void;
  audioBytes: number | null;
  onRunSetup: () => void;
  onClose: () => void;
};

const modifierKeys = ["Control", "Shift", "Alt", "Meta"];

/** A keyboard chord as a shortcut accelerator, or null for a lone modifier or a key without
 * one (a global shortcut on a bare key would capture it system-wide). F-keys may stand alone. */
function accelerator(event: KeyboardEvent): string | null {
  if (modifierKeys.includes(event.key)) return null;
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

/** The saved chord as key caps, plus a button that captures the next one. */
function ShortcutCapture(props: {
  label: string;
  value: string;
  disabled: boolean;
  optional?: boolean;
  onCapture: (chord: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  // Set when a key press was refused for lacking a modifier, so the refusal is not silent.
  const [refused, setRefused] = useState(false);
  const stopCapturing = () => {
    setCapturing(false);
    setRefused(false);
  };
  const keys = props.value ? shortcutLabel(props.value).split("+") : [];
  return (
    <>
      <span className="om-kbd-row" aria-label={`${props.label} shortcut`}>
        {keys.length > 0 ? (
          keys.map((key) => <kbd key={key}>{key}</kbd>)
        ) : (
          <span className="om-muted">None</span>
        )}
      </span>
      <button
        type="button"
        className="om-sm"
        aria-label={`Change ${props.label.toLowerCase()} shortcut`}
        disabled={props.disabled}
        onClick={() => setCapturing(true)}
        onBlur={stopCapturing}
        onKeyDown={(event) => {
          // Tab still moves focus, so capturing never traps the keyboard.
          if (!capturing || event.key === "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") return stopCapturing();
          const chord = accelerator(event);
          if (chord) {
            props.onCapture(chord);
            stopCapturing();
          } else if (!modifierKeys.includes(event.key)) {
            setRefused(true);
          }
        }}
      >
        {capturing ? "Press keys…" : "Change"}
      </button>
      {props.optional && props.value !== "" && (
        <button
          type="button"
          className="om-ghost om-sm"
          aria-label={`Clear ${props.label.toLowerCase()} shortcut`}
          disabled={props.disabled}
          onClick={() => props.onCapture("")}
        >
          Clear
        </button>
      )}
      {refused && (
        <span role="status" className="om-muted">
          Add Ctrl or Alt, or use an F-key.
        </span>
      )}
    </>
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
    <select
      aria-label={props.label}
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
  );
}

/** A miniature window drawn with the live tokens, so the theme choice is visible. */
function ThemePreview() {
  return (
    <div className="om-card om-pv" aria-hidden="true">
      <div className="om-pv-side">
        <span className="om-pv-mark" />
        <span className="om-pv-bar om-w80" />
        <span className="om-pv-bar om-w60" />
        <span className="om-pv-bar om-w70" />
      </div>
      <div className="om-pv-main">
        <div className="om-pv-top">
          <span className="om-pv-bar om-w40" />
          <span className="om-pv-pill" />
        </div>
        <div className="om-pv-body">
          <span className="om-pv-bar om-w90" />
          <span className="om-pv-bar om-w75" />
          <span className="om-pv-bar om-w60" />
          <span className="om-pv-cta" />
        </div>
      </div>
    </div>
  );
}

function GeneralSection(props: Props) {
  const { shown, mark } = useSaved();
  const theme = props.settings?.theme ?? "system";
  return (
    <div className="om-pane">
      <h2>General</h2>
      <Group label="Appearance">
        <Rows>
          <Row label="Theme">
            <Segmented
              label="Theme"
              value={theme}
              disabled={props.disabled || !props.settings}
              options={[
                { id: "system", title: "System" },
                { id: "dark", title: "Dark" },
                { id: "light", title: "Light" },
              ]}
              onChange={(next) => {
                props.onTheme?.(next);
                mark();
              }}
            />
            <Saved show={shown} />
          </Row>
        </Rows>
      </Group>
      <Group label="Preview">
        <ThemePreview />
      </Group>
    </div>
  );
}

function RecordingSection(props: Props) {
  const { settings, disabled } = props;
  const capture = useSaved();
  const automation = useSaved();
  const pause = settings?.pause_shortcut ?? "";
  const stop = settings?.stop_shortcut ?? "";
  const sameShortcuts =
    stop.trim() !== "" &&
    stop.trim().toLowerCase() === pause.trim().toLowerCase();
  const automatic = props.processing.mode !== "recording";
  // Set when a captured chord was refused as the pause shortcut, so the refusal is not silent.
  const [clash, setClash] = useState(false);
  const saveShortcuts = (nextPause: string, nextStop: string) => {
    // The same chord twice is refused here, before it reaches the backend.
    const same =
      nextStop.trim() !== "" &&
      nextStop.trim().toLowerCase() === nextPause.trim().toLowerCase();
    setClash(same);
    if (same) return;
    props.onSaveShortcuts(nextPause, nextStop);
  };
  const devices = (microphone: string, output: string) => {
    if (!microphone || !output) return;
    props.onDefaultDevices(microphone, output);
    capture.mark();
  };
  const ignored = settings?.detection_ignored ?? [];
  return (
    <div className="om-pane">
      <h2>Recording</h2>

      <Group label="Capture" saved={capture.shown}>
        <Rows>
          <Row label="Microphone">
            <DeviceSelect
              label="Default microphone"
              value={settings?.microphone_id ?? ""}
              devices={props.devices?.microphones ?? []}
              disabled={disabled}
              onChange={(id) =>
                devices(id, settings?.output_id ?? props.output)
              }
            />
          </Row>
          <Row label="System audio">
            <DeviceSelect
              label="Default system audio"
              value={settings?.output_id ?? ""}
              devices={props.devices?.outputs ?? []}
              disabled={disabled}
              onChange={(id) =>
                devices(settings?.microphone_id ?? props.microphone, id)
              }
            />
          </Row>
        </Rows>
        <CardFoot>
          <button
            type="button"
            className="om-ghost om-sm"
            disabled={disabled}
            onClick={props.onRefreshDevices}
          >
            Refresh devices
          </button>
        </CardFoot>
      </Group>

      <Group label="Shortcuts">
        <Rows>
          <Row label="Pause / resume">
            <ShortcutCapture
              label="Pause / resume"
              value={pause}
              disabled={disabled}
              onCapture={(chord) => saveShortcuts(chord, stop)}
            />
          </Row>
          <Row label="Stop recording">
            <ShortcutCapture
              label="Stop recording"
              value={stop}
              disabled={disabled}
              optional
              onCapture={(chord) => saveShortcuts(pause, chord)}
            />
          </Row>
        </Rows>
        {sameShortcuts || clash ? (
          <p role="alert" className="om-error">
            Pause and stop can&apos;t use the same shortcut.
          </p>
        ) : null}
      </Group>

      <Group label="Automation" saved={automation.shown}>
        <Rows>
          <Row label="Automatic processing">
            <Switch
              label="Automatic processing"
              checked={automatic}
              disabled={disabled}
              onChange={(on) => {
                props.onProcessing({
                  mode: on ? "final" : "recording",
                  summary: on
                    ? (props.processing.summary ?? "general-v1")
                    : null,
                });
                automation.mark();
              }}
            />
          </Row>
          {automatic && (
            <div className="om-preview">
              <span className="om-group-label">When on</span>
              <div className="om-frow">
                <span>After stop</span>
                <select
                  aria-label="When a recording stops"
                  value={props.processing.mode}
                  disabled={disabled}
                  onChange={(event) =>
                    props.onProcessing({
                      mode: event.target.value as ProcessingChoice["mode"],
                      summary:
                        event.target.value === "final"
                          ? (props.processing.summary ?? "general-v1")
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
              </div>
              {props.processing.mode === "final" && (
                <div className="om-frow">
                  <span>Summary</span>
                  <select
                    aria-label="Automatic summary"
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
                </div>
              )}
            </div>
          )}
          <Row
            label="Meeting detection"
            detail={
              props.detectionSupported
                ? "Offer to record when an app uses the microphone"
                : "Not available on this platform yet"
            }
          >
            <Switch
              label="Meeting detection"
              checked={settings?.detection_enabled ?? false}
              disabled={disabled || !settings || !props.detectionSupported}
              onChange={(on) => {
                props.onDetection(on);
                automation.mark();
              }}
            />
          </Row>
          <Row
            label="Automatic capture"
            detail={
              <span>
                Starts a recording with your saved devices when a supported call
                app (Teams, Zoom, Slack, Discord, Webex, Skype) uses the
                microphone. Browsers and other apps still only prompt. You can
                stop or pause at any time. A manual stop or pause blocks
                automatic restart for that call. Audio is stored on this PC, as
                for any recording.
                {!settings?.detection_enabled &&
                  " Turn on meeting detection first."}
              </span>
            }
          >
            <Switch
              label="Automatic capture"
              checked={settings?.auto_capture ?? false}
              disabled={disabled || !settings || !settings.detection_enabled}
              onChange={(on) => {
                props.onAutoCapture(on);
                automation.mark();
              }}
            />
          </Row>
        </Rows>
        {settings?.detection_enabled && ignored.length > 0 && (
          <More summary="Never prompt for">
            <div className="om-frow">
              <span>Never prompt for</span>
              <span className="om-tag">
                {ignored.length} {ignored.length === 1 ? "app" : "apps"}
              </span>
            </div>
            {ignored.map((app) => (
              <div className="om-appline" key={app.id}>
                <span title={app.id}>{app.name}</span>
                <button
                  type="button"
                  className="om-ghost om-sm"
                  disabled={disabled}
                  onClick={() => props.onDetectionIgnored(app, false)}
                >
                  Prompt again
                </button>
              </div>
            ))}
          </More>
        )}
      </Group>

      <LiveSettings
        settings={settings}
        disabled={disabled}
        onSaved={props.onSettings}
      />

      <CalendarSettings
        settings={settings}
        disabled={disabled}
        onSaved={props.onSettings}
      />
    </div>
  );
}

function ExportSection(props: Props) {
  const { settings, disabled } = props;
  const { shown, mark } = useSaved();
  // The real data folder, read once: the page never guesses it.
  const [dataFolder, setDataFolder] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void api.dataFolder().then(
      (value) => {
        if (live) setDataFolder(value.path);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const copyDataFolder = () => {
    if (!dataFolder) return;
    void navigator.clipboard.writeText(dataFolder).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const choices = settings?.export;
  const formats = choices?.transcript_formats ?? [];
  const save = (options: ExportOptions) => {
    props.onExportOptions(options);
    mark();
  };
  const toggleFormat = (format: "txt" | "srt" | "vtt") => {
    if (!choices) return;
    save({
      ...choices,
      transcript_formats: formats.includes(format)
        ? formats.filter((chosen) => chosen !== format)
        : [...formats, format],
    });
  };
  return (
    <div className="om-pane">
      <h2>Export &amp; storage</h2>

      <Group label="Folders">
        <Rows>
          <Row
            label="Export folder"
            detail={
              <span className="om-path">
                {settings?.vault_folder
                  ? displayPath(settings.vault_folder)
                  : "Not selected"}
              </span>
            }
          >
            <button
              type="button"
              className="om-sm"
              disabled={disabled}
              onClick={props.onChooseFolder}
            >
              Change
            </button>
          </Row>
          <Row
            label="Data folder"
            detail={
              <span className="om-path">
                {dataFolder ? displayPath(dataFolder) : "Not available yet"}
              </span>
            }
          >
            {dataFolder && (
              <button
                type="button"
                className="om-ghost om-sm"
                aria-label="Copy data folder path"
                disabled={disabled}
                onClick={copyDataFolder}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </Row>
        </Rows>
      </Group>

      <Group label="Markdown export" saved={shown}>
        <Rows>
          <Row label="Include transcript">
            <Switch
              label="Include transcript"
              checked={choices?.transcript ?? false}
              disabled={disabled || !choices}
              onChange={(on) => choices && save({ ...choices, transcript: on })}
            />
          </Row>
          <Row label="Include summary">
            <Switch
              label="Include summary"
              checked={choices?.summary ?? false}
              disabled={disabled || !choices}
              onChange={(on) => choices && save({ ...choices, summary: on })}
            />
          </Row>
          <Row label="File name">
            <select
              aria-label="File name"
              value={choices?.filename ?? "title"}
              disabled={disabled || !choices}
              onChange={(event) =>
                choices &&
                save({
                  ...choices,
                  filename:
                    event.target.value === "date_title"
                      ? "date_title"
                      : "title",
                })
              }
            >
              <option value="title">Meeting title</option>
              <option value="date_title">Date, then title</option>
            </select>
          </Row>
        </Rows>
      </Group>

      <Group label="Transcript files">
        <div className="om-card">
          <div className="om-chips" role="group" aria-label="Transcript files">
            {(["txt", "srt", "vtt"] as const).map((format) => (
              <button
                key={format}
                type="button"
                className="om-chip"
                aria-pressed={formats.includes(format)}
                aria-label={format.toUpperCase()}
                disabled={disabled || !choices}
                onClick={() => toggleFormat(format)}
              >
                {format.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </Group>

      <div className="om-foot-note">
        <span className="om-mono">
          {props.audioBytes === null
            ? "Unknown"
            : formatBytes(props.audioBytes)}
        </span>
        <span>of audio</span>
      </div>
    </div>
  );
}

function AboutSection(props: Props) {
  return (
    <div className="om-pane">
      <h2>Privacy &amp; about</h2>

      <Group label="What leaves this device">
        <div className="om-card om-table-card">
          <table className="om-leaves-table">
            <tbody>
              <tr>
                <th scope="row">Recording audio</th>
                <td>Never, unless you use cloud speech</td>
              </tr>
              <tr>
                <th scope="row">Transcript text</th>
                <td>Only to your AI connection, when you use it</td>
              </tr>
              <tr>
                <th scope="row">API keys</th>
                <td>Windows Credential Manager</td>
              </tr>
              <tr>
                <th scope="row">Model searches</th>
                <td>huggingface.co; no meeting content</td>
              </tr>
              <tr>
                <th scope="row">Local AI</th>
                <td>Never; it runs on this PC</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Group>

      <Group label="Files">
        <p className="om-file-note">
          Meeting files are not encrypted. Keep the data and export folders in a
          place only you can open.
        </p>
      </Group>

      <Group label="About">
        <Rows>
          <Row label="Version">
            <span className="om-mono om-muted">{props.version ?? version}</span>
          </Row>
          <Row label="First-run setup">
            <button
              type="button"
              className="om-ghost om-sm"
              disabled={props.disabled}
              onClick={props.onRunSetup}
            >
              Run setup again
            </button>
          </Row>
          <Row label="Licenses">
            <span className="om-mono om-muted">THIRD_PARTY_LICENSES.md</span>
          </Row>
        </Rows>
      </Group>
    </div>
  );
}

/** The speech connection card, shown only while the engine is Cloud. */
function CloudConnection(props: Props & { active: boolean }) {
  if (!props.settings) return null;
  return (
    <ConnectionEditor
      role="cloud_stt"
      settings={props.settings}
      active={props.active}
      disabled={props.disabled}
      onSaved={props.onSettings}
      onKeyStatus={props.onKeyStatus}
    />
  );
}

function TranscriptionSection(props: Props & { active: boolean }) {
  const settings = props.settings;
  // Model files already on this PC, for the model menu. The scan is local and read-only, and
  // runs only while the section is open on the local engine; the library's scans add to it.
  const [localFiles, setLocalFiles] = useState<LocalModel[]>([]);
  const local = settings?.stt_mode !== "cloud";
  useEffect(() => {
    if (!props.active || !local) return;
    let live = true;
    // Promise.resolve: a stubbed api in tests may return nothing.
    void Promise.resolve()
      .then(() => api.scanLocalModels(null))
      .then((scan) => {
        if (live && scan) setLocalFiles(scan.models);
      })
      .catch(() => {
        /* The library shows scan errors; the menu keeps what it has. */
      });
    return () => {
      live = false;
    };
  }, [props.active, local]);
  const addFiles = (scan: ModelScan) =>
    setLocalFiles((known) => [
      ...known.filter(
        (file) => !scan.models.some((found) => found.path === file.path),
      ),
      ...scan.models,
    ]);
  return (
    <TranscriptionSettings
      localFiles={localFiles}
      settings={settings}
      disabled={props.disabled}
      stt={props.stt}
      sttProgress={props.sttProgress}
      installing={props.installing}
      onMode={props.onSttMode}
      onInstall={props.onInstallStt}
      onDownload={props.onDownloadStt}
      onCancel={props.onCancelStt}
      onSave={props.onSaveStt}
      library={
        <ModelLibrary
          disabled={props.disabled}
          onImported={props.onImported}
          onScan={addFiles}
          onUse={(id) =>
            settings &&
            props.onSaveStt({
              stt_language: settings.stt_language,
              stt_prompt: settings.stt_prompt,
              stt_model: id,
            })
          }
        />
      }
      cloudForm={settings ? <CloudConnection {...props} /> : null}
    />
  );
}

/** The two places AI notes are written. */
type AiBranch = "local" | "connection";

/** The branch the saved settings describe: a remote connection, otherwise this PC. */
function aiBranchOf(settings: Settings | null): AiBranch {
  const llm = settings?.llm;
  return llm && !isLocalBase(llm.base_url) ? "connection" : "local";
}

const aiChoices: Segment<AiBranch>[] = [
  { id: "local", title: "On this PC", note: "Stays on this device" },
  { id: "connection", title: "With a connection", leaves: true },
];

/** The destination AI notes really use, so the view choice never implies a saved change. */
function savedAiDestination(settings: Settings): string {
  const llm = settings.llm;
  if (!llm)
    return "Saved destination: none yet. Switching this view saves nothing.";
  if (isLocalBase(llm.base_url))
    return `Saved destination: this PC (${hostOf(llm.base_url)}). Switching this view saves nothing.`;
  const id = settings.provider_assignments.llm?.connection_id;
  const name = settings.saved_connections.find((item) => item.id === id)?.name;
  return `Saved destination: ${name ?? hostOf(llm.base_url)}, leaves this device. Switching this view saves nothing.`;
}

/**
 * AI notes opens with one choice. Only the chosen path shows; during a search both paths stay
 * in the page, so a match in the hidden one is found. The choice saves nothing by itself.
 */
function AiSection(
  props: Props & {
    active: boolean;
    searching: boolean;
    /** Set when the section was opened as "connections": that path opens first. */
    preferred?: AiBranch;
  },
) {
  // The user's pick for this session; until they make one, the settings (or the alias) decide.
  const [pick, setPick] = useState<AiBranch | null>(null);
  const branch = pick ?? props.preferred ?? aiBranchOf(props.settings);
  return (
    <div className="om-pane">
      <h2>AI notes</h2>
      <Group label="Notes written">
        <Segmented
          label="Notes written"
          value={branch}
          options={aiChoices}
          onChange={setPick}
        />
        {props.settings && (
          <p className="om-muted">{savedAiDestination(props.settings)}</p>
        )}
      </Group>
      <div hidden={!props.searching && branch !== "connection"}>
        <Group label="Connection">
          {props.settings ? (
            <ConnectionEditor
              role="llm"
              settings={props.settings}
              active={props.active}
              disabled={props.disabled}
              onSaved={props.onSettings}
              onKeyStatus={props.onKeyStatus}
            />
          ) : (
            <p className="om-empty">Settings are still loading.</p>
          )}
        </Group>
      </div>
      <div hidden={!props.searching && branch !== "local"}>
        <Group label="Local AI">
          <LocalAi
            active={props.active}
            disabled={props.disabled}
            onSettings={props.onSettings}
          />
        </Group>
      </div>
      <Group label="Templates">
        <SummaryTemplates
          settings={props.settings}
          disabled={props.disabled}
          onSettings={props.onSettings}
          onDefaultTemplate={props.onSummaryDefault}
        />
      </Group>
      <EnhanceSwitch
        settings={props.settings}
        disabled={props.disabled}
        onSettings={props.onSettings}
      />
    </div>
  );
}

/** Automatic processing also writes enhanced notes; the switch saves at once and starts nothing itself. */
function EnhanceSwitch(props: {
  settings: Settings | null;
  disabled: boolean;
  onSettings: (settings: Settings) => void;
}) {
  const saved = useSaved();
  const [failure, setFailure] = useState("");
  return (
    <Group label="Enhanced notes" saved={saved.shown}>
      <Rows>
        <Row
          label="Enhance my notes after recording"
          detail="Off unless you turn it on. Runs after a recording, with the summary, when Automatic processing is on. Your notes and the final transcript go to the AI notes destination above. Your typed notes stay as they are."
        >
          <Switch
            label="Enhance my notes after recording"
            checked={props.settings?.processing_enhance ?? false}
            disabled={props.disabled || !props.settings}
            onChange={(enabled) => {
              setFailure("");
              api.saveProcessingEnhance(enabled).then(
                (settings) => {
                  props.onSettings(settings);
                  saved.mark();
                },
                () => setFailure("The switch could not be saved. Try again."),
              );
            }}
          />
        </Row>
        {failure && (
          <p className="om-muted" role="alert">
            {failure}
          </p>
        )}
      </Rows>
    </Group>
  );
}

/** What needs the user in each section, as one short reason; empty when nothing does. */
function needsYou(props: Props): Partial<Record<SettingsSectionId, string>> {
  const needs: Partial<Record<SettingsSectionId, string>> = {};
  const { settings, devices } = props;
  if (devices?.capture_supported) {
    const mic = devices.microphones.some((d) => d.id === props.microphone);
    const speakers = devices.outputs.some((d) => d.id === props.output);
    if (!mic || !speakers) needs.recording = "Choose a microphone and speakers";
  }
  if (
    settings &&
    settings.stt_mode !== "cloud" &&
    props.stt &&
    !props.stt.installed
  )
    needs.transcription = "Download a speech model";
  if (settings && !settings.llm) needs.ai = "Choose where notes are written";
  return needs;
}

/** Quick searches under the field: the words people look for most. */
const quickSearches = [
  "Theme",
  "API key",
  "Model",
  "Shortcuts",
  "Export folder",
];

const fold = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, " ");

/** Marks the label that search adds to a disclosure it opened; never searched itself. */
const SEARCH_TAG = "data-search-label";
/** Set on a disclosure search opened (it was closed); it counts as closed until search ends. */
const SEARCH_OPENED = "data-search-opened";

/**
 * The text a person can read in a group. Menus count their picked option only. A closed
 * disclosure counts only when `everything` is set, which is how search finds what sits behind
 * "More options"; a disclosure that search opened counts as closed, so the page settles.
 */
function textOf(node: Node, everything: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.hasAttribute(SEARCH_TAG)) return "";
  if (node instanceof HTMLSelectElement)
    return Array.from(node.selectedOptions, (option) => option.text).join(" ");
  if (node.tagName === "OPTION") return "";
  const closed =
    !everything &&
    node.tagName === "DETAILS" &&
    (!(node as HTMLDetailsElement).open || node.hasAttribute(SEARCH_OPENED));
  let text = "";
  for (const child of Array.from(node.childNodes)) {
    if (closed && !(child instanceof Element && child.tagName === "SUMMARY"))
      continue;
    text += " " + textOf(child, everything);
  }
  return text;
}

/** Opens a closed disclosure for search and labels it. */
function openForSearch(details: HTMLDetailsElement) {
  details.setAttribute(SEARCH_OPENED, "");
  details.open = true;
  const summary = Array.from(details.children).find(
    (child) => child.tagName === "SUMMARY",
  );
  if (!summary || summary.querySelector(`[${SEARCH_TAG}]`)) return;
  const tag = document.createElement("span");
  tag.className = "om-search-tag";
  tag.setAttribute(SEARCH_TAG, "");
  tag.textContent = "in More options";
  summary.append(tag);
}

/** Closes a disclosure search opened, as it was before, and takes its label away. */
function closeAfterSearch(details: HTMLDetailsElement) {
  details.open = false;
  details.removeAttribute(SEARCH_OPENED);
  details.querySelector(`[${SEARCH_TAG}]`)?.remove();
}

/** Top-level groups of a section: every `.om-group` that is not inside another one. */
function groupsOf(section: HTMLElement): HTMLElement[] {
  return Array.from(section.querySelectorAll<HTMLElement>(".om-group")).filter(
    (group) => !group.parentElement?.closest(".om-group"),
  );
}

function SearchIcon() {
  return (
    <svg
      className="om-search-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <circle
        cx="7"
        cy="7"
        r="4.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10.5 10.5 14 14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SettingsPanel(props: Props) {
  // Uncontrolled fallback: without `section` the panel owns the requested section.
  const [own, setOwn] = useState<SettingsSectionId>(() =>
    resolveSettingsSection(props.initialSection ?? "general"),
  );
  const controlled = props.section !== undefined;
  const section = controlled
    ? resolveSettingsSection(props.section as SettingsSection)
    : own;
  // The section in view while scrolling; the index marks it.
  const [current, setCurrent] = useState<SettingsSectionId>(section);
  const [query, setQuery] = useState("");
  const words = fold(query.trim());
  // Matching groups per section while a search runs.
  const [hits, setHits] = useState<Partial<Record<SettingsSectionId, number>>>(
    {},
  );
  const main = useRef<HTMLDivElement>(null);
  const indexNav = useRef<HTMLElement>(null);
  // The section picked from the index or the shell; it stays current until the user scrolls.
  const wanted = useRef<SettingsSectionId | null>(null);
  const needs = needsYou(props);
  const needCount = Object.keys(needs).length;

  const scrollTo = (id: SettingsSectionId) => {
    wanted.current = id;
    setCurrent(id);
    document
      .getElementById(`settings-${id}`)
      ?.scrollIntoView?.({ block: "start" });
  };
  // A section picked while a search hides it: the search clears, then the page scrolls there.
  const pending = useRef<SettingsSectionId | null>(null);
  const pick = (id: SettingsSectionId) => {
    if (!controlled) setOwn(id);
    props.onSection?.(id);
    if (words && !hits[id]) {
      pending.current = id;
      setQuery("");
      return;
    }
    scrollTo(id);
  };
  // Before the section is controlled, the shell may open the panel again on another one.
  useEffect(() => {
    if (!controlled && props.initialSection)
      setOwn(resolveSettingsSection(props.initialSection));
  }, [controlled, props.initialSection]);
  // A requested section (from the shell or an "Open Settings" link) scrolls into view.
  useEffect(() => {
    scrollTo(section);
  }, [section]);

  // Scroll spy: the last section whose top has passed under the search bar is current. At the
  // bottom of the page short sections never reach the top, so a visible pick is kept there.
  useEffect(() => {
    const root = main.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (wanted.current) return;
      const line = root.getBoundingClientRect().top + 140;
      const tops = settingsSections.map(([id]) => {
        const el = document.getElementById(`settings-${id}`);
        // Sections hidden by a search have no box and never count.
        const shown = el && !el.hasAttribute("data-miss");
        return [id, shown ? el.getBoundingClientRect() : null] as const;
      });
      const atBottom =
        root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      setCurrent((known) => {
        if (atBottom) {
          const box = tops.find(([id]) => id === known)?.[1];
          if (box && box.top < root.getBoundingClientRect().bottom)
            return known;
        }
        let next = known;
        for (const [id, box] of tops) if (box && box.top <= line) next = id;
        return next;
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // A wheel, touch or key scroll is the user's own: the spy takes over again.
    const release = () => {
      wanted.current = null;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
      root.addEventListener(type, release, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
        root.removeEventListener(type, release);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Search hides the groups that do not mention the words; a section title match keeps the
  // whole section. It reads the rendered text, so every label, option and value is findable.
  useLayoutEffect(() => {
    const next: Partial<Record<SettingsSectionId, number>> = {};
    // Closed disclosures that hold a match: search opens them while the words are typed.
    const opened = new Set<HTMLDetailsElement>();
    for (const [id, label] of settingsSections) {
      const el = document.getElementById(`settings-${id}`);
      if (!el) continue;
      const groups = groupsOf(el);
      const whole = words === "" || fold(label).includes(words);
      let count = 0;
      for (const group of groups) {
        let hit = whole || fold(textOf(group, false)).includes(words);
        if (!hit && words) {
          for (const details of Array.from(group.querySelectorAll("details"))) {
            if (details.open && !details.hasAttribute(SEARCH_OPENED)) continue;
            if (fold(textOf(details, true)).includes(words)) {
              opened.add(details);
              hit = true;
            }
          }
        }
        group.toggleAttribute("data-miss", !hit);
        if (hit) count += 1;
      }
      if (groups.length === 0)
        count = whole || fold(textOf(el, false)).includes(words) ? 1 : 0;
      el.toggleAttribute("data-miss", count === 0);
      next[id] = count;
    }
    // Search closes the disclosures it opened that no longer hold a match, and opens the rest.
    const root = main.current;
    for (const details of Array.from(
      root?.querySelectorAll<HTMLDetailsElement>(`details[${SEARCH_OPENED}]`) ??
        [],
    ))
      if (!opened.has(details)) closeAfterSearch(details);
    for (const details of opened) openForSearch(details);
    setHits((known) =>
      settingsSections.every(([id]) => known[id] === next[id]) ? known : next,
    );
    if (pending.current && words === "") {
      const id = pending.current;
      pending.current = null;
      scrollTo(id);
    }
  });
  // The one authored moment: results rise into place when the search changes.
  const firstQuery = useRef(true);
  useLayoutEffect(() => {
    if (firstQuery.current) {
      firstQuery.current = false;
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const [id] of settingsSections) {
      const el = document.getElementById(`settings-${id}`);
      if (el && !el.hasAttribute("data-miss"))
        el.animate?.(
          [
            { opacity: 0, transform: "translateY(4px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 140, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
        );
    }
  }, [words]);
  // A new search starts at the top, and the index follows the first section that matches.
  useEffect(() => {
    if (!words) return;
    wanted.current = null;
    main.current?.scrollTo?.({ top: 0, behavior: "instant" });
  }, [words]);
  useEffect(() => {
    if (!words) return;
    const first = settingsSections.find(([id]) => hits[id]);
    if (first) setCurrent(first[0]);
  }, [words, hits]);
  const total = settingsSections.reduce(
    (sum, [id]) => sum + (hits[id] ?? 0),
    0,
  );

  return (
    <section
      className="om-settings"
      ref={props.panelRef}
      aria-labelledby="settings-title"
    >
      <header className="om-head">
        <button
          type="button"
          className="om-back"
          aria-label="Back to Meetings"
          onClick={props.onClose}
        >
          ← Meetings
        </button>
        <kbd>Esc</kbd>
        <span className="om-rule" />
        <h1 id="settings-title">Settings</h1>
        <span className="om-spacer" />
        <span className="om-version om-mono">{props.version ?? version}</span>
      </header>
      <div className="om-body">
        <div className="om-main" ref={main}>
          <div className="om-search">
            <label className="om-search-field">
              <SearchIcon />
              <input
                type="search"
                aria-label="Search settings"
                placeholder="Search settings"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // Escape clears the search; Settings stays open (Escape outside a field leaves).
                  if (event.key === "Escape" && query !== "") {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {words && (
                <span className="om-search-count" role="status">
                  {total === 1 ? "1 group" : `${total} groups`}
                </span>
              )}
            </label>
            <a
              href="#settings-index"
              className="om-skip"
              onClick={(event) => {
                event.preventDefault();
                const entry =
                  indexNav.current?.querySelector<HTMLButtonElement>(
                    "[aria-current]",
                  ) ??
                  indexNav.current?.querySelector<HTMLButtonElement>("button");
                entry?.focus();
              }}
            >
              Skip to sections
            </a>
            <div className="om-qchips" role="group" aria-label="Quick searches">
              {needCount > 0 && (
                <button
                  type="button"
                  className="om-qchip om-qchip-need"
                  onClick={() => {
                    const first = settingsSections.find(([id]) => needs[id]);
                    if (!first) return;
                    setQuery("");
                    pick(first[0]);
                  }}
                >
                  <span className="om-need" aria-hidden="true" />
                  {`Needs you · ${needCount}`}
                </button>
              )}
              {quickSearches.map((term) => (
                <button
                  key={term}
                  type="button"
                  className="om-qchip"
                  aria-pressed={fold(term) === words}
                  onClick={() => setQuery(fold(term) === words ? "" : term)}
                >
                  {term}
                </button>
              ))}
            </div>
          </div>
          <div className="om-wrap">
            {words && total === 0 && (
              <p className="om-no-match">
                No settings match “{query.trim()}”.
                <button
                  type="button"
                  className="om-ghost om-sm"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </button>
              </p>
            )}
            {settingsSections.map(([id, label]) => (
              <section
                key={id}
                id={`settings-${id}`}
                className="om-section"
                aria-label={label}
              >
                {needs[id] && (
                  <p className="om-need-line">
                    <span className="om-need" aria-hidden="true" />
                    {needs[id]}
                  </p>
                )}
                {id === "general" && <GeneralSection {...props} />}
                {id === "recording" && <RecordingSection {...props} />}
                {id === "transcription" && (
                  <TranscriptionSection {...props} active />
                )}
                {id === "ai" && (
                  <AiSection
                    {...props}
                    active
                    searching={words !== ""}
                    preferred={
                      (props.section ?? props.initialSection) === "connections"
                        ? "connection"
                        : undefined
                    }
                  />
                )}
                {id === "export" && <ExportSection {...props} />}
                {id === "about" && <AboutSection {...props} />}
              </section>
            ))}
          </div>
        </div>
        <nav
          id="settings-index"
          ref={indexNav}
          aria-label="Settings sections"
          className="om-sections"
        >
          <span className="om-index-label">On this page</span>
          {settingsSections.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={current === id ? "location" : undefined}
              className={words && !hits[id] ? "om-dim" : undefined}
              title={
                words && !hits[id]
                  ? "No match here; clears the search"
                  : undefined
              }
              onClick={() => pick(id)}
            >
              <span>{label}</span>
              {words ? (
                <span className="om-hit-count" aria-hidden="true">
                  {hits[id] ?? 0}
                </span>
              ) : (
                needs[id] && (
                  <span
                    className="om-need"
                    aria-hidden="true"
                    title={needs[id]}
                  />
                )
              )}
              {needs[id] && (
                <span className="om-sr-only">{`, needs you: ${needs[id]}`}</span>
              )}
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}
