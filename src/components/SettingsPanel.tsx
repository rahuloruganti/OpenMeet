import { useState, type Ref } from "react";
import type {
  ExportOptions,
  KeyStatus,
  ProviderRole,
  Settings,
  SttDownloadProgress,
  SttStatus,
} from "../lib/api";
import { ProviderSettings } from "./ProviderSettings";
import { SpeechModels } from "./SpeechModels";

const tabs = [
  { id: "speech", label: "Speech to text" },
  { id: "summaries", label: "Summaries" },
  { id: "automatic", label: "Automatic processing" },
  { id: "general", label: "General" },
] as const;
type TabId = (typeof tabs)[number]["id"];

export type SttDraft = Pick<
  Settings,
  "stt_language" | "stt_prompt" | "stt_model"
>;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
const languageName = (code: string) => {
  if (code === "auto") return "Detect automatically";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

type Props = {
  panelRef: Ref<HTMLElement>;
  settings: Settings | null;
  disabled: boolean;
  shortcut: string;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  onInstallStt: () => void;
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
  onSttStatus: (status: SttStatus) => void;
  onAutoTranscribe: (enabled: boolean) => void;
};

export function SettingsPanel(props: Props) {
  const { settings, disabled } = props;
  const [tab, setTab] = useState<TabId>("speech");
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
      <p className="panel-description">Make OpenMeet work the way you do.</p>
      <div
        className="content-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="settings-grid">
        {tab === "speech" && (
          <section
            className="settings-section"
            aria-label="Transcription settings"
          >
            <h3>Speech to text</h3>
            <label>
              Transcription mode
              <select
                value={settings?.stt_mode ?? "local"}
                disabled={disabled}
                onChange={(event) =>
                  props.onSttMode(
                    event.target.value === "cloud" ? "cloud" : "local",
                  )
                }
              >
                <option value="local">Local Whisper</option>
                <option value="cloud">Cloud API</option>
              </select>
            </label>
            {settings?.stt_mode === "cloud" ? (
              <>
                <p className="muted">
                  Audio is uploaded to your selected provider after
                  confirmation. Local model downloads are not required. Some
                  models return text without timestamps.
                </p>
                <ProviderSettings
                  role="cloud_stt"
                  config={settings.cloud_stt}
                  keyStatus={props.keyStatus.cloud_stt}
                  disabled={disabled}
                  onSaved={props.onSettings}
                  onKeyStatus={props.onKeyStatus}
                />
              </>
            ) : (
              <>
                <p className="muted">Audio stays on this device.</p>
                <p>
                  <strong>
                    {!props.stt
                      ? "Status unavailable"
                      : !props.stt.supported
                        ? "Not supported on this platform yet"
                        : props.stt.installed
                          ? "Installed and verified"
                          : "Not installed"}
                  </strong>
                </p>
                <p className="muted">
                  Transcribe on your computer with Whisper. Audio stays here.
                  Available on Windows x64.
                </p>
                <details className="help-details">
                  <summary>About model downloads</summary>
                  <p>
                    Whisper and Silero models come from huggingface.co; the
                    engine comes from github.com. Downloads are checked against
                    pinned SHA-256 checksums. Switching models keeps existing
                    downloads.
                  </p>
                </details>
                <SpeechModels
                  stt={props.stt}
                  selected={props.sttDraft.stt_model}
                  disabled={disabled}
                  onSelect={(id) => props.onStt({ stt_model: id })}
                  onStatus={props.onSttStatus}
                />
              </>
            )}
            <label>
              Spoken language
              <select
                value={props.sttDraft.stt_language}
                disabled={disabled}
                onChange={(event) =>
                  props.onStt({ stt_language: event.target.value })
                }
              >
                {(props.stt?.languages ?? [props.sttDraft.stt_language]).map(
                  (code) => (
                    <option key={code} value={code}>
                      {languageName(code)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              Vocabulary hint (names, jargon; optional)
              <input
                value={props.sttDraft.stt_prompt}
                disabled={disabled}
                maxLength={500}
                placeholder="e.g. Priya, Okta, Kubernetes"
                onChange={(event) =>
                  props.onStt({ stt_prompt: event.target.value })
                }
              />
            </label>
            <button disabled={disabled} onClick={props.onSaveStt}>
              Save transcription settings
            </button>
            {settings?.stt_mode !== "cloud" && (
              <>
                {props.sttProgress && (
                  <p role="status">
                    Downloading {props.sttProgress.stage}:{" "}
                    {mb(props.sttProgress.downloaded)} /{" "}
                    {mb(props.sttProgress.total)} MB
                  </p>
                )}
                <button
                  disabled={
                    disabled ||
                    props.installing ||
                    !props.stt?.supported ||
                    props.stt.installed
                  }
                  onClick={props.onInstallStt}
                >
                  {props.stt?.installed
                    ? "Speech engine installed"
                    : `Download speech engine and models (≈ ${mb(props.stt?.missing_bytes ?? 0)} MB)`}
                </button>
              </>
            )}
          </section>
        )}
        {tab === "summaries" && (
          <section className="settings-section" aria-label="Summary settings">
            <ProviderSettings
              role="llm"
              config={settings?.llm ?? null}
              keyStatus={props.keyStatus.llm}
              disabled={disabled}
              onSaved={props.onSettings}
              onKeyStatus={props.onKeyStatus}
            />
          </section>
        )}
        {tab === "automatic" && (
          <section
            className="settings-section"
            aria-label="Automatic processing"
          >
            <h3>Automatic processing</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={settings?.auto_transcribe ?? false}
                disabled={
                  disabled || !settings || settings.stt_mode === "cloud"
                }
                onChange={(event) =>
                  props.onAutoTranscribe(event.target.checked)
                }
              />
              <span>Transcribe on this device when a recording stops</span>
            </label>
            <p className="muted">
              Uses the local speech model chosen under Speech to text. Audio
              stays on this device and the previous transcript is kept if a run
              fails.
            </p>
            {settings?.stt_mode === "cloud" && (
              <p className="muted">
                Not available with cloud transcription: uploading audio always
                needs your confirmation for each recording.
              </p>
            )}
            <p className="muted">
              Summaries are never sent automatically. Use Enhance notes on a
              meeting to review and confirm what is sent to your provider.
            </p>
          </section>
        )}
        {tab === "general" && (
          <>
            <section
              className="settings-section"
              aria-label="Storage and export settings"
            >
              <h3>Storage & export</h3>
              <p className="muted">
                Notes and audio are stored on this device, unencrypted. Exported
                snapshots keep your earlier files intact.
              </p>
              <label>
                Export folder
                <output>{settings?.vault_folder ?? "Not selected"}</output>
              </label>
              <button disabled={disabled} onClick={props.onChooseFolder}>
                Choose export folder
              </button>
            </section>
            <section
              className="settings-section"
              aria-label="Keyboard shortcuts"
            >
              <h3>Keyboard shortcuts</h3>
              <label>
                Pause / resume shortcut
                <input
                  value={props.shortcut}
                  disabled={disabled}
                  onChange={(event) => props.onShortcut(event.target.value)}
                  placeholder="CommandOrControl+Shift+Space"
                />
              </label>
              <label>
                Stop recording shortcut (optional)
                <input
                  value={props.stopShortcut}
                  disabled={disabled}
                  onChange={(event) => props.onStopShortcut(event.target.value)}
                  placeholder="Leave empty for none"
                />
              </label>
              <p className="muted">
                There is no shortcut to start recording: starting always goes
                through setup and consent.
              </p>
              <button
                disabled={disabled || !props.shortcut.trim()}
                onClick={props.onSaveShortcut}
              >
                Save shortcuts
              </button>
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
                        filename: event.target
                          .value as ExportOptions["filename"],
                      })
                    }
                  >
                    <option value="title">Meeting title</option>
                    <option value="date_title">Date, then meeting title</option>
                  </select>
                </label>
                <p className="muted">
                  Applies to new exports. Earlier snapshots are never renamed or
                  overwritten.
                </p>
              </fieldset>
            )}
          </>
        )}
      </div>
    </section>
  );
}
