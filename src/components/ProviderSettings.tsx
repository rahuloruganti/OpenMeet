import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  isLocalBase,
  type KeyChange,
  type KeyStatus,
  type ProviderConfig,
  type ProviderModel,
  type ProviderRole,
  type Settings,
} from "../lib/api";

type Props = {
  role: ProviderRole;
  config: ProviderConfig | null;
  keyStatus: KeyStatus;
  disabled: boolean;
  onSaved: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
};

export function ProviderSettings(props: Props) {
  const { role, config } = props;
  const label = role === "llm" ? "Summary" : "Cloud speech";
  const password = useRef<HTMLInputElement>(null);
  const currentRevision = useRef(config?.revision);
  currentRevision.current = config?.revision;
  const [baseUrl, setBaseUrl] = useState(config?.base_url ?? "");
  const [model, setModel] = useState(config?.model ?? "");
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [custom, setCustom] = useState(!config?.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const disabled = props.disabled || busy;
  const unsavedUrl = baseUrl.trim() !== (config?.base_url ?? "");
  const savedModel = config?.model;
  const local = isLocalBase(config?.base_url ?? "");

  useEffect(() => {
    setBaseUrl(config?.base_url ?? "");
    setModel(config?.model ?? "");
    setModels(null);
    setCustom(!config?.model);
    const field = password.current;
    if (field) field.value = "";
    return () => {
      if (field) field.value = "";
    };
  }, [config?.revision, config?.base_url, config?.model]);

  const run = async (task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
      // A stale revision or partial failure needs the backend's current settings.
      try {
        props.onSaved(await api.getSettings());
        props.onKeyStatus(role, await api.providerKeyStatus(role));
      } catch {
        props.onKeyStatus(role, "unavailable");
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const saveConnection = async (change: KeyChange) => {
    const updated = await api.saveProviderConnection(
      role,
      baseUrl.trim(),
      change,
      config?.revision ?? null,
    );
    props.onSaved(updated);
    props.onKeyStatus(role, await api.providerKeyStatus(role));
    setNotice("Connection saved on this device. No meeting content was sent.");
  };

  return (
    <fieldset className="provider-settings" disabled={disabled}>
      <legend>
        {role === "llm" ? "Summaries and questions" : "Cloud speech connection"}
      </legend>
      <p role="status">
        {props.keyStatus === "present"
          ? "API key saved in the OS keychain"
          : props.keyStatus === "missing"
            ? local
              ? "Local server. API key optional."
              : "No API key saved"
            : "API key status unavailable"}
      </p>
      <p className="panel-description">
        Enter an OpenAI-compatible API base, including its path, such as
        https://provider.example/v1. Local servers can use HTTP on localhost.
        Refreshing models sends credentials, when saved, to the saved
        destination. It sends no meeting content.
      </p>
      <label>
        {label} API base URL
        <input
          type="url"
          value={baseUrl}
          placeholder="https://provider.example/v1"
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <label>
        {label} API key
        <input
          ref={password}
          type="password"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="muted">
        Pasted keys briefly enter this window before being saved in the OS
        keychain. Leave the field empty to keep the saved key at the same URL.
        Changing to a remote URL requires entering a key for that destination.
        For a local server, leave the key empty if it does not require one.
      </p>
      <div className="panel-actions">
        <button
          disabled={disabled || !baseUrl.trim()}
          onClick={() => {
            if (lock.current) return;
            const key = password.current?.value ?? "";
            if (password.current) password.current.value = "";
            void run(() =>
              saveConnection(key ? { kind: "replace", key } : { kind: "keep" }),
            );
          }}
        >
          Save {label.toLowerCase()} connection
        </button>
        <button
          disabled={
            disabled || !config || unsavedUrl || props.keyStatus !== "present"
          }
          onClick={() => {
            if (password.current) password.current.value = "";
            void run(() => saveConnection({ kind: "remove" }));
          }}
        >
          Remove {label.toLowerCase()} key
        </button>
      </div>
      {unsavedUrl && (
        <p className="muted">
          Save this connection before refreshing or selecting a model.
        </p>
      )}
      <button
        disabled={
          disabled ||
          !config ||
          unsavedUrl ||
          (props.keyStatus !== "present" && !local)
        }
        onClick={() =>
          void run(async () => {
            if (!config) return;
            const choices = await api.listProviderModels(role, config.revision);
            if (currentRevision.current !== config.revision) return;
            setModels(choices);
            setNotice(
              "Model IDs fetched. Compatibility with this task is unverified.",
            );
          })
        }
      >
        Refresh {label.toLowerCase()} models
      </button>
      {models?.length === 0 && (
        <p>No models returned. Enter a custom model ID.</p>
      )}
      <label>
        {label} model
        <select
          value={custom ? "" : model}
          disabled={disabled || !config || unsavedUrl}
          onChange={(event) => {
            const value = event.target.value;
            setCustom(value === "");
            if (value) setModel(value);
          }}
        >
          <option value="">Enter model ID</option>
          {model && !models?.some((item) => item.id === model) && (
            <option value={model}>{model} (unverified)</option>
          )}
          {models?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
            </option>
          ))}
        </select>
      </label>
      {(custom || !model) && (
        <label>
          {label} custom model ID
          <input
            value={model}
            maxLength={200}
            disabled={disabled || !config || unsavedUrl}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
      )}
      <p className="muted">
        Saved model: {savedModel ?? "Not selected"}. Model IDs are unverified
        until used successfully.
      </p>
      <button
        disabled={disabled || !config || unsavedUrl || !model.trim()}
        onClick={() =>
          void run(async () => {
            if (!config) return;
            props.onSaved(
              await api.saveProviderModel(role, model.trim(), config.revision),
            );
            setNotice("Model selection saved. No meeting content was sent.");
          })
        }
      >
        Save {label.toLowerCase()} model
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
