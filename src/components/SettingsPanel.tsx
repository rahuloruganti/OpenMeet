import { useState, type Ref } from "react";
import type {
  ExportOptions,
  KeyStatus,
  ProviderRole,
  Settings,
  SttDownloadProgress,
  SttStatus,
} from "../lib/api";
import { ModelLibrary } from "./ModelLibrary";
import { ProviderSettings } from "./ProviderSettings";

export type SttDraft = Pick<
  Settings,
  "stt_language" | "stt_prompt" | "stt_model"
>;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
const settingsTabs = ["cloud", "local", "general"] as const;
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
};

export function SettingsPanel(props: Props) {
  const { settings, disabled } = props;
  const [tab, setTab] = useState<"cloud" | "local" | "general">("local");
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
      <label>
        Transcription mode
        <select
          value={settings?.stt_mode ?? "local"}
          disabled={disabled}
          onChange={(event) =>
            props.onSttMode(event.target.value === "cloud" ? "cloud" : "local")
          }
        >
          <option value="local">Local Whisper</option>
          <option value="cloud">API connection</option>
        </select>
      </label>
      <div
        role="tablist"
        aria-label="Settings sections"
        className="settings-tabs"
      >
        {settingsTabs.map((value, index) => (
          <button
            key={value}
            id={`settings-tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`settings-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (event.ctrlKey || event.altKey || event.metaKey) return;
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? settingsTabs.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % settingsTabs.length
                      : event.key === "ArrowLeft"
                        ? (index + settingsTabs.length - 1) %
                          settingsTabs.length
                        : null;
              if (nextIndex === null) return;
              const next = settingsTabs[nextIndex];
              if (!next) return;
              event.preventDefault();
              setTab(next);
              document.getElementById(`settings-tab-${next}`)?.focus();
            }}
          >
            {value === "cloud"
              ? "Cloud API"
              : value === "local"
                ? "Local"
                : "General"}
          </button>
        ))}
      </div>
      <div
        id="settings-cloud"
        role="tabpanel"
        aria-labelledby="settings-tab-cloud"
        hidden={tab !== "cloud"}
      >
        {settings && (
          <ProviderSettings
            settings={settings}
            local={false}
            active={tab === "cloud"}
            disabled={disabled}
            onSaved={props.onSettings}
            onKeyStatus={props.onKeyStatus}
          />
        )}
        <p className="muted">
          Cloud speech uploads audio only after separate confirmation. Summaries
          and questions send text after separate confirmation.
        </p>
      </div>
      <div
        id="settings-local"
        role="tabpanel"
        aria-labelledby="settings-tab-local"
        hidden={tab !== "local"}
        className="settings-grid"
      >
        <div className="settings-column">
          <section
            className="settings-section"
            aria-label="Transcription settings"
          >
            <h3>Speech to text</h3>
            <>
              <p className="muted">Local Whisper keeps audio on this device.</p>
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
                Windows uses the published engine. Apple Silicon requires the
                separately pinned local whisper.cpp build.
              </p>
              <details className="help-details">
                <summary>About model downloads</summary>
                <p>
                  Whisper and Silero models come from huggingface.co; the engine
                  comes from github.com. Downloads are checked against pinned
                  SHA-256 checksums. Switching models keeps existing downloads.
                </p>
              </details>
              <label>
                Speech model
                <select
                  value={props.sttDraft.stt_model}
                  disabled={disabled}
                  onChange={(event) =>
                    props.onStt({ stt_model: event.target.value })
                  }
                >
                  {props.stt?.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} ({mb(item.size)} MB
                      {item.installed ? ", downloaded" : ""})
                    </option>
                  ))}
                </select>
              </label>
            </>
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
                {props.installing && (
                  <button onClick={props.onCancelStt}>
                    Cancel speech download
                  </button>
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
          <ModelLibrary disabled={disabled} onImported={props.onImported} />
        </div>
        {settings && (
          <ProviderSettings
            settings={settings}
            local
            active={tab === "local"}
            disabled={disabled}
            onSaved={props.onSettings}
            onKeyStatus={props.onKeyStatus}
          />
        )}
      </div>
      <div
        id="settings-general"
        role="tabpanel"
        aria-labelledby="settings-tab-general"
        hidden={tab !== "general"}
        className="settings-grid"
      >
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
        <section className="settings-section" aria-label="Keyboard shortcuts">
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
            <p className="muted">
              Applies to new exports. Earlier snapshots are never renamed or
              overwritten.
            </p>
          </fieldset>
        )}
      </div>
    </section>
  );
}
