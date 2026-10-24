import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  isLocalBase,
  type KeyChange,
  type KeyStatus,
  type ProviderModel,
  type ProviderRole,
  type Settings,
} from "../../shared/api/api";
import { modelsFor } from "../../shared/lib/models";
import { destination, type Publish } from "../../shared/ui/provider-connection";
import { Saved, useSaved } from "../../shared/ui/settings-link";

// One sentence each, and each says the action that fixes it (TEXT RULES).
const urlFormat = "Use a full URL like https://api.example.com/v1.";
const urlRules =
  "Use https, or http on localhost, without credentials or a query.";

/** The first reason an API base URL cannot be saved, mirroring validate_base_url in providers.rs. */
export function baseUrlError(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return urlFormat;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return urlFormat;
  if (
    /\s/.test(text) ||
    /[?#]/.test(text) ||
    url.username !== "" ||
    url.password !== ""
  )
    return urlRules;
  return url.protocol === "http:" && !isLocalBase(text) ? urlRules : null;
}

/** "No connection" in the saved-connection picker: the task runs without one. */
const NONE = "-";

type Props = Publish & {
  role: ProviderRole;
  settings: Settings;
  disabled: boolean;
  /** False while the section is hidden: the typed key must not stay in the page. */
  active: boolean;
};

/** One OpenAI-compatible connection and the task that uses it: keys need an explicit Save. */
export function ConnectionEditor(props: Props) {
  const assignment = props.settings.provider_assignments[props.role];
  const [selected, setSelected] = useState(assignment?.connection_id ?? "");
  const connection =
    props.settings.saved_connections.find((item) => item.id === selected) ??
    null;
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState(assignment?.model ?? "");
  const [status, setStatus] = useState<KeyStatus>("unavailable");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [keyEntered, setKeyEntered] = useState(false);
  const { shown, mark } = useSaved();
  // Results render below the card; bring them into view so a long page never hides them.
  const outcome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice || error)
      outcome.current?.scrollIntoView?.({ block: "nearest" });
  }, [notice, error]);
  const password = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const current = useRef(connection);
  current.current = connection;
  const connectionDirty =
    name !== (connection?.name ?? "") ||
    baseUrl !== (connection?.base_url ?? "");
  const assigned = assignment?.connection_id ?? "";
  const selectedConnection = selected === NONE ? null : selected;
  const roleDirty =
    selectedConnection !== assigned ||
    (selected !== NONE && model.trim() !== (assignment?.model ?? ""));
  const disabled = props.disabled || busy;
  const urlError = baseUrlError(baseUrl);
  const missingFields = selected === "" && (!name.trim() || !baseUrl.trim());
  const neededModel = selected !== NONE && model.trim() === "";
  const canSave =
    !disabled &&
    !missingFields &&
    urlError === null &&
    !neededModel &&
    (connectionDirty || roleDirty || keyEntered);
  // One reason per disabled button, shown only for the cause that applies.
  const refreshReason =
    !connection || connectionDirty
      ? "Save the connection first."
      : !isLocalBase(connection.base_url) && status === "missing"
        ? "Add an API key first."
        : null;
  const removeReason =
    !connection || status === "missing"
      ? "No saved key to remove."
      : connectionDirty
        ? "Save the connection first."
        : null;
  useEffect(() => {
    if (password.current) password.current.value = "";
    setName(connection?.name ?? "");
    setBaseUrl(connection?.base_url ?? "");
    setModels([]);
    setKeyEntered(false);
    setStatus(connection ? "unavailable" : "missing");
    let live = true;
    if (connection)
      void api
        .apiConnectionKeyStatus(connection.id)
        .then((value) => {
          if (live) setStatus(value);
        })
        .catch(() => {
          if (live) setStatus("unavailable");
        });
    return () => {
      live = false;
    };
  }, [
    connection?.id,
    connection?.revision,
    connection?.name,
    connection?.base_url,
  ]);
  // The saved model follows the assignment, so a save elsewhere is not overwritten.
  useEffect(() => {
    setModel(assignment?.model ?? "");
  }, [assignment?.model]);
  useEffect(() => {
    const field = password.current;
    if (!props.active && field) field.value = "";
    return () => {
      if (field) field.value = "";
    };
  }, [props.active]);
  const publish = (settings: Settings) => {
    props.onSaved(settings);
    for (const role of ["llm", "cloud_stt"] satisfies ProviderRole[]) {
      void api.providerKeyStatus(role).then(
        (value) => props.onKeyStatus(role, value),
        () => props.onKeyStatus(role, "unavailable"),
      );
    }
  };
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
      try {
        publish(await api.getSettings());
      } catch {
        /* Keep the visible error when refresh also fails. */
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const saveKeyChange = (keyChange: KeyChange) =>
    run(async () => {
      if (!connection) return;
      publish(
        await api.saveApiConnection({
          id: connection.id,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          keyChange,
          expectedRevision: connection.revision,
        }),
      );
      mark();
      setNotice("Key updated on this device.");
    });
  const choose = (id: string) => {
    if (
      (connectionDirty || keyEntered) &&
      !window.confirm("Discard unsaved connection edits?")
    )
      return;
    if (password.current) password.current.value = "";
    setSelected(id);
    setError("");
    setNotice("");
  };
  const save = () =>
    run(async () => {
      const key = password.current?.value ?? "";
      if (password.current) password.current.value = "";
      let settings = props.settings;
      let connectionId: string | null = selected === NONE ? null : selected;
      if (
        connectionId !== null &&
        (connectionDirty || connectionId === "" || key !== "")
      ) {
        settings = await api.saveApiConnection({
          id: connection?.id ?? null,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          keyChange: key ? { kind: "replace", key } : { kind: "keep" },
          expectedRevision: connection?.revision ?? null,
        });
        const saved = settings.saved_connections.find((item) =>
          connectionId
            ? item.id === connectionId
            : item.name === name.trim() && item.base_url === baseUrl.trim(),
        );
        connectionId = saved?.id ?? null;
        if (saved) {
          setSelected(saved.id);
          setStatus(
            await api
              .apiConnectionKeyStatus(saved.id)
              .catch(() => "unavailable" as const),
          );
        }
        publish(settings);
      }
      const target = settings.provider_assignments[props.role];
      if (connectionId === null) {
        if (target)
          settings = await api.saveProviderAssignment(
            props.role,
            { kind: "unassigned" },
            target.revision,
          );
      } else if (
        connectionId !== target?.connection_id ||
        model.trim() !== (target?.model ?? "")
      ) {
        settings = await api.saveProviderAssignment(
          props.role,
          {
            kind: "assigned",
            connection_id: connectionId,
            model: model.trim(),
          },
          target?.revision ?? null,
        );
      }
      publish(settings);
      setKeyEntered(false);
      mark();
      setNotice("Saved on this device. No meeting content was sent.");
    });
  const label = props.role === "llm" ? "AI notes" : "Transcription";
  return (
    <section className="provider-settings" aria-label={`${label} connection`}>
      <div className="om-card om-rows">
        <div className="om-row">
          <div className="om-what">
            <strong>Connection</strong>
            {props.role === "llm" && (
              <span className="om-leaves">Leaves this device</span>
            )}
          </div>
          <div className="om-side">
            <select
              aria-label="Saved connection"
              value={selected}
              disabled={disabled}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="">New connection</option>
              {props.settings.saved_connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {destination(item.base_url)}
                </option>
              ))}
              <option value={NONE}>No connection</option>
            </select>
          </div>
        </div>
        <div className="om-row">
          <div className="om-what">
            <strong>Base URL</strong>
          </div>
          <div className="om-side">
            <input
              aria-label="Base URL"
              className="om-mono"
              type="url"
              value={baseUrl}
              disabled={disabled || selected === NONE}
              placeholder="https://api.example.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
        </div>
        <div className="om-row">
          <div className="om-what">
            <strong>API key</strong>
          </div>
          <div className="om-side">
            <input
              aria-label="API key"
              className="om-mono"
              ref={password}
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled || selected === NONE}
              onChange={() => setKeyEntered(true)}
            />
            {status === "present" ? (
              <span className="om-saved">Key saved</span>
            ) : (
              <span className="om-muted">
                {isLocalBase(baseUrl) ? "Key optional" : "No key"}
              </span>
            )}
          </div>
        </div>
        <div className="om-row">
          <div className="om-what">
            <strong>Model</strong>
          </div>
          <div className="om-side">
            <input
              aria-label="Model"
              className="om-mono"
              value={model}
              list="om-provider-models"
              maxLength={200}
              disabled={disabled || selected === NONE}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="om-provider-models">
              {modelsFor(models, props.role).map((item) => (
                <option key={item.id} value={item.id} />
              ))}
            </datalist>
          </div>
        </div>
      </div>
      <div className="om-card-foot">
        <button
          type="button"
          className="om-sm"
          disabled={!canSave}
          onClick={() => void save()}
        >
          Save
        </button>
        <span className="om-spacer" />
        <button
          type="button"
          className="om-ghost om-sm"
          disabled={
            disabled ||
            !connection ||
            connectionDirty ||
            (!isLocalBase(connection.base_url) && status !== "present")
          }
          title={refreshReason ?? undefined}
          onClick={() =>
            void run(async () => {
              if (!connection) return;
              const choices = await api.listApiConnectionModels(
                connection.id,
                connection.revision,
              );
              if (
                current.current?.id !== connection.id ||
                current.current?.revision !== connection.revision
              )
                return;
              setModels(choices);
              setNotice(
                "Model IDs fetched. Compatibility with each task is unverified.",
              );
            })
          }
        >
          Refresh models
        </button>
        {refreshReason && <span className="om-muted">{refreshReason}</span>}
        <Saved show={shown} />
      </div>
      <details className="om-more">
        <summary>More options</summary>
        <div className="om-more-body">
          <div className="om-frow">
            <span>Connection name</span>
            <input
              aria-label="Connection name"
              value={name}
              maxLength={100}
              disabled={disabled || selected === NONE}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {urlError && (
            <p role="alert" className="om-error">
              {urlError}
            </p>
          )}
          {missingFields && <p className="om-muted">Enter a name and a URL.</p>}
          <div className="om-frow">
            <span>Saved key</span>
            <button
              type="button"
              className="om-ghost om-sm om-danger"
              disabled={
                disabled ||
                !connection ||
                connectionDirty ||
                status !== "present"
              }
              title={removeReason ?? undefined}
              onClick={() => void saveKeyChange({ kind: "remove" })}
            >
              Remove key
            </button>
          </div>
          <div className="om-frow">
            <span>Connection</span>
            <button
              type="button"
              className="om-ghost om-sm om-danger"
              disabled={
                disabled ||
                !connection ||
                Object.values(props.settings.provider_assignments).some(
                  (item) => item?.connection_id === connection.id,
                )
              }
              onClick={() =>
                void run(async () => {
                  if (!connection) return;
                  publish(
                    await api.deleteApiConnection(
                      connection.id,
                      connection.revision,
                    ),
                  );
                  setSelected("");
                })
              }
            >
              Delete connection
            </button>
          </div>
        </div>
      </details>
      {models.length > 0 && (
        <ul className="om-ids" aria-label="Discovered model IDs">
          {models.map((item) => (
            <li key={item.id}>
              <span className="om-mono">{item.id}</span>
            </li>
          ))}
        </ul>
      )}
      <div ref={outcome}>
        {notice && <p className="om-muted">{notice}</p>}
        {error && (
          <p role="alert" className="om-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
