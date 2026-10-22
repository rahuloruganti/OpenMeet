import type {
  KeyStatus,
  ProviderModel,
  ProviderRole,
  Settings,
  SttDownloadProgress,
  SttStatus,
} from "../lib/api";
import { formatBytes } from "../lib/meeting-labels";
import { Assignment } from "./ProviderSettings";

export type SttDraft = Pick<
  Settings,
  "stt_language" | "stt_prompt" | "stt_model"
>;

const languageName = (code: string) => {
  if (code === "auto") return "Detect automatically";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

export const sttDirty = (settings: Settings | null, draft: SttDraft) =>
  !!settings &&
  (settings.stt_language !== draft.stt_language ||
    settings.stt_prompt !== draft.stt_prompt ||
    settings.stt_model !== draft.stt_model);

/** Engine choice, local Whisper setup or the speech API assignment, and shared speech options. */
export function TranscriptionSettings(props: {
  settings: Settings | null;
  disabled: boolean;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  /** Catalog models a library scan found on disk but not imported yet. */
  found: string[];
  models: { connectionId: string; models: ProviderModel[] } | null;
  sttDraft: SttDraft;
  onStt: (change: Partial<SttDraft>) => void;
  onSaveStt: () => void;
  onSttMode: (mode: Settings["stt_mode"]) => void;
  onInstallStt: () => void;
  onCancelStt: () => void;
  onSettings: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
}) {
  const { settings, disabled, stt } = props;
  const cloud = settings?.stt_mode === "cloud";
  return (
    <section className="settings-section" aria-label="Transcription settings">
      <h3>Speech to text</h3>
      <fieldset className="choice-cards" disabled={disabled}>
        <legend>Transcription engine</legend>
        <label className="choice-card">
          <input
            type="radio"
            name="stt-mode"
            checked={!cloud}
            onChange={() => props.onSttMode("local")}
          />
          <span>
            <strong>Local Whisper</strong>
            <span className="muted">Audio stays on this computer.</span>
          </span>
        </label>
        <label className="choice-card">
          <input
            type="radio"
            name="stt-mode"
            checked={cloud}
            onChange={() => props.onSttMode("cloud")}
          />
          <span>
            <strong>API connection</strong>
            <span className="muted">
              Uploads audio to your speech connection.
            </span>
          </span>
        </label>
      </fieldset>
      {cloud ? (
        settings && (
          <Assignment
            role="cloud_stt"
            settings={settings}
            disabled={disabled}
            models={props.models}
            onSaved={props.onSettings}
            onKeyStatus={props.onKeyStatus}
          />
        )
      ) : (
        <>
          <p>
            <strong>
              {!stt
                ? "Status unavailable"
                : !stt.supported
                  ? "Not supported on this platform yet"
                  : stt.installed
                    ? "Installed and verified"
                    : "Not installed"}
            </strong>
          </p>
          <details className="help-details">
            <summary>About model downloads</summary>
            <p>
              Whisper and Silero models come from huggingface.co; the engine
              comes from github.com. Downloads are checked against pinned
              SHA-256 checksums. Switching models keeps existing downloads.
              Apple Silicon uses the separately pinned local whisper.cpp build.
            </p>
          </details>
          <label>
            Available speech models
            <select
              value={props.sttDraft.stt_model}
              disabled={disabled}
              onChange={(event) =>
                props.onStt({ stt_model: event.target.value })
              }
            >
              {stt?.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id} ({formatBytes(item.size)}
                  {item.installed
                    ? ", downloaded"
                    : props.found.includes(item.id)
                      ? ", found on this computer"
                      : ""}
                  )
                </option>
              ))}
            </select>
          </label>
          {props.sttProgress && (
            <p role="status">
              Downloading {props.sttProgress.stage}:{" "}
              {formatBytes(props.sttProgress.downloaded)} /{" "}
              {formatBytes(props.sttProgress.total)}
            </p>
          )}
          <div className="panel-actions">
            <button
              disabled={
                disabled || props.installing || !stt?.supported || stt.installed
              }
              onClick={props.onInstallStt}
            >
              {stt?.installed
                ? "Speech engine installed"
                : `Download speech engine and models (≈ ${formatBytes(stt?.missing_bytes ?? 0)})`}
            </button>
            {props.installing && (
              <button onClick={props.onCancelStt}>
                Cancel speech download
              </button>
            )}
          </div>
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
          {(stt?.languages ?? [props.sttDraft.stt_language]).map((code) => (
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
          onChange={(event) => props.onStt({ stt_prompt: event.target.value })}
        />
      </label>
      {sttDirty(settings, props.sttDraft) && (
        <button disabled={disabled} onClick={props.onSaveStt}>
          Save transcription settings
        </button>
      )}
    </section>
  );
}
