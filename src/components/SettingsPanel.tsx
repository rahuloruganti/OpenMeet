import type { Ref } from "react";
import type {
  ExportOptions,
  MergeModel,
  Settings,
  SttDownloadProgress,
  SttStatus,
} from "../lib/api";

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
  mergeKey: boolean | null;
  mergeModel: string;
  mergeModels: MergeModel[] | null;
  onMergeModel: (value: string) => void;
  onImportKey: () => void;
  onDeleteKey: () => void;
  onRefreshMerge: () => void;
  onSaveMerge: () => void;
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
};

export function SettingsPanel(props: Props) {
  const { settings, disabled } = props;
  const { mergeKey, mergeModel, mergeModels } = props;
  const mergeSelectable = mergeModels?.find((m) => m.model === mergeModel);
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
      <div className="settings-grid">
        <section
          className="settings-section"
          aria-label="Transcription settings"
        >
          <h3>Speech to text (local)</h3>
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
            Transcribe on your computer with Whisper. Audio stays here. Windows
            uses the published engine. This Mac uses a local whisper.cpp build.
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
          <label>
            Spoken language
            <select
              value={props.sttDraft.stt_language}
              disabled={disabled}
              onChange={(event) =>
                props.onStt({ stt_language: event.target.value })
              }
            >
              {props.stt?.languages.map((code) => (
                <option key={code} value={code}>
                  {languageName(code)}
                </option>
              ))}
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
          <button disabled={disabled || !props.stt} onClick={props.onSaveStt}>
            Save transcription settings
          </button>
          {props.sttProgress && (
            <p role="status">
              Downloading {props.sttProgress.stage}:{" "}
              {mb(props.sttProgress.downloaded)} / {mb(props.sttProgress.total)}{" "}
              MB
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
        </section>
        <section className="settings-section" aria-label="Summary settings">
          <h3>Merge Gateway</h3>
          <p>
            <strong>
              {mergeKey === null
                ? "API key status unavailable"
                : mergeKey
                  ? "API key saved in the OS keychain"
                  : "No API key saved"}
            </strong>
          </p>
          <p className="muted">
            Summaries and meeting questions use Merge. Each send asks for your
            confirmation. Audio is never sent.
          </p>
          <details className="help-details">
            <summary>Key setup & privacy</summary>
            <p className="muted">
              The key is imported from the OPENMEET_LLM_API_KEY environment
              variable by the desktop backend and stored in the OS keychain; it
              never enters this window. Set the variable before starting
              OpenMeet. Connecting sends only your API key to
              api-gateway.merge.dev to list models; no meeting content is sent.
              Notes and transcript text are sent only when you confirm a summary
              or question for a meeting. Audio is never sent.
            </p>
          </details>
          <div className="panel-actions">
            <button disabled={disabled} onClick={props.onImportKey}>
              Import key from environment
            </button>
            <button
              disabled={disabled || !mergeKey}
              onClick={props.onDeleteKey}
            >
              Remove saved key
            </button>
          </div>
          <button
            disabled={disabled || !mergeKey}
            onClick={props.onRefreshMerge}
          >
            Connect / refresh Merge models
          </button>
          {mergeModels === null && (
            <p className="muted">Merge models not fetched.</p>
          )}
          {mergeModels?.length === 0 && (
            <p role="status">Merge returned no models for this key.</p>
          )}
          <label>
            Merge model
            <select
              value={mergeModel}
              disabled={disabled || !mergeModels?.length}
              onChange={(event) => props.onMergeModel(event.target.value)}
            >
              <option value="">Select a Merge model</option>
              {mergeModel && !mergeSelectable && (
                <option value={mergeModel} disabled>
                  {mergeModel} (
                  {mergeModels === null ? "not checked" : "unavailable"})
                </option>
              )}
              {mergeModels?.map((item) => (
                <option
                  key={item.model}
                  value={item.model}
                  disabled={!item.available}
                >
                  {item.display_name ?? item.model}
                  {item.available
                    ? ""
                    : ` (unavailable: ${item.unavailable_reason ?? "unknown"})`}
                </option>
              ))}
            </select>
          </label>
          <p>Saved Merge model: {settings?.merge_model ?? "Not selected"}</p>
          <button
            disabled={disabled || !mergeSelectable?.available}
            onClick={props.onSaveMerge}
          >
            Save Merge model
          </button>
        </section>
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
                    filename: event.target.value as ExportOptions["filename"],
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
