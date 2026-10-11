import type { Ref } from "react";
import type { MergeModel, Settings, SttProgress, SttStatus } from "../lib/api";

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

type Props = {
  panelRef: Ref<HTMLElement>;
  settings: Settings | null;
  disabled: boolean;
  shortcut: string;
  stt: SttStatus | null;
  sttProgress: SttProgress | null;
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
        Uses whisper.cpp with the multilingual Whisper “small” model and Silero
        voice detection. The files are downloaded once from github.com (engine)
        and huggingface.co (models), checked against pinned SHA-256 checksums,
        and run entirely on this computer. Audio is never uploaded. Windows x64
        only for now.
      </p>
      {props.sttProgress && (
        <p role="status">
          Downloading {props.sttProgress.stage}:{" "}
          {mb(props.sttProgress.downloaded)} / {mb(props.sttProgress.total)} MB
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
        The key is imported from the OPENMEET_LLM_API_KEY environment variable
        by the desktop backend and stored in the OS keychain; it never enters
        this window. Set the variable before starting OpenMeet. Connecting sends
        only your API key to api-gateway.merge.dev to list models. No meeting
        notes, transcripts, or audio are sent, and summaries are not implemented
        yet.
      </p>
      <div className="panel-actions">
        <button disabled={disabled} onClick={props.onImportKey}>
          Import key from environment
        </button>
        <button disabled={disabled || !mergeKey} onClick={props.onDeleteKey}>
          Remove saved key
        </button>
      </div>
      <button disabled={disabled || !mergeKey} onClick={props.onRefreshMerge}>
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
      <p>
        <strong>Storage:</strong> SQLite in the OS app-data folder. Merge is
        contacted only when you press Connect / refresh or confirm a summary. No
        telemetry.
      </p>
      <label>
        Export folder
        <output>{settings?.vault_folder ?? "Not selected"}</output>
      </label>
      <button disabled={disabled} onClick={props.onChooseFolder}>
        Choose export folder
      </button>
      <label>
        Pause / resume shortcut
        <input
          value={props.shortcut}
          disabled={disabled}
          onChange={(event) => props.onShortcut(event.target.value)}
          placeholder="CommandOrControl+Shift+Space"
        />
      </label>
      <button
        disabled={disabled || !props.shortcut.trim()}
        onClick={props.onSaveShortcut}
      >
        Save shortcut
      </button>
    </section>
  );
}
