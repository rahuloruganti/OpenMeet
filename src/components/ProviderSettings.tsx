import { useEffect, useId, useRef, useState } from "react";
import {
  api,
  errorMessage,
  isLocalBase,
  type KeyChange,
  type KeyStatus,
  type ProviderModel,
  type ProviderRole,
  type Settings,
} from "../lib/api";
import { modelsFor } from "../lib/models";
import { useTask } from "../lib/use-task";

type Publish = {
  onSaved: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
};

/** Hands saved settings to App and refreshes both tasks' key status. */
export async function publishSettings(settings: Settings, to: Publish) {
  to.onSaved(settings);
  for (const role of ["llm", "cloud_stt"] satisfies ProviderRole[]) {
    try {
      to.onKeyStatus(role, await api.providerKeyStatus(role));
    } catch {
      to.onKeyStatus(role, "unavailable");
    }
  }
}

/** Badge text for a connection: loopback stays on this device. */
export const destination = (baseUrl: string) =>
  isLocalBase(baseUrl) ? "This device" : "Leaves this device";

type Props = Publish & {
  settings: Settings;
  active: boolean;
  disabled: boolean;
  /** Model IDs fetched for a saved connection, for the task assignments. */
  onModels: (connectionId: string, models: ProviderModel[]) => void;
};

/** Saved OpenAI-compatible connections, local and remote in one list. */
export function Connections(props: Props) {
  const [selected, setSelected] = useState("");
  const connection =
    props.settings.saved_connections.find((item) => item.id === selected) ??
    null;
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<KeyStatus>("unavailable");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Results render below the task assignments; bring them into view so a long
  // settings page never hides the outcome of the button just pressed.
  const outcome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice || error)
      outcome.current?.scrollIntoView?.({ block: "nearest" });
  }, [notice, error]);
  const password = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const current = useRef(connection);
  current.current = connection;
  const dirty =
    name !== (connection?.name ?? "") ||
    baseUrl !== (connection?.base_url ?? "");
  const disabled = props.disabled || busy;
  useEffect(() => {
    if (password.current) password.current.value = "";
    setName(connection?.name ?? "");
    setBaseUrl(connection?.base_url ?? "");
    setModels([]);
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
  useEffect(() => {
    const field = password.current;
    if (!props.active && field) field.value = "";
    return () => {
      if (field) field.value = "";
    };
  }, [props.active]);
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
        await publish(await api.getSettings());
      } catch {
        /* Keep the visible error when refresh also fails. */
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const publish = (settings: Settings) => publishSettings(settings, props);
  const save = async (keyChange: KeyChange) => {
    const updated = await api.saveApiConnection({
      id: connection?.id ?? null,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      keyChange,
      expectedRevision: connection?.revision ?? null,
    });
    await publish(updated);
    const saved = updated.saved_connections.find((item) =>
      connection
        ? item.id === connection.id
        : item.name === name.trim() && item.base_url === baseUrl.trim(),
    );
    if (saved) {
      setSelected(saved.id);
      try {
        setStatus(await api.apiConnectionKeyStatus(saved.id));
      } catch {
        setStatus("unavailable");
      }
    }
    setNotice("Connection saved on this device. No meeting content was sent.");
  };
  return (
    <section
      className="settings-section provider-settings"
      aria-label="API connections"
    >
      <h3>API connections</h3>
      <p className="muted">
        Reusable OpenAI-compatible connections. Refresh models sends saved
        credentials to the saved destination. It sends no meeting content. Model
        IDs do not establish task compatibility.
      </p>
      <fieldset disabled={disabled}>
        <legend>Connection</legend>
        <label>
          Saved connection
          <select
            value={selected}
            onChange={(event) => {
              if (
                (dirty || password.current?.value) &&
                !window.confirm("Discard unsaved connection edits?")
              )
                return;
              if (password.current) password.current.value = "";
              setSelected(event.target.value);
              setError("");
              setNotice("");
            }}
          >
            <option value="">New connection</option>
            {props.settings.saved_connections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {destination(item.base_url)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Connection name
          <input
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          API base URL
          <input
            type="url"
            value={baseUrl}
            placeholder="https://provider.example/v1 or http://127.0.0.1:1234/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label>
          API key
          <input
            ref={password}
            type="password"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="muted">
          Keys briefly enter this window, then the OS keychain. Leave empty to
          keep the saved key at the same URL. A new remote destination requires
          its own key. Local HTTP servers must use loopback.
        </p>
        <p role="status">
          {status === "present"
            ? "API key saved in the OS keychain"
            : status === "missing"
              ? isLocalBase(baseUrl)
                ? "Local server. API key optional."
                : "No API key saved"
              : "API key status unavailable"}
        </p>
        <div className="panel-actions">
          <button
            disabled={disabled || !name.trim() || !baseUrl.trim()}
            onClick={() => {
              if (lock.current) return;
              const key = password.current?.value ?? "";
              if (password.current) password.current.value = "";
              void run(() =>
                save(key ? { kind: "replace", key } : { kind: "keep" }),
              );
            }}
          >
            Save connection
          </button>
          <button
            disabled={disabled || !connection || dirty || status !== "present"}
            onClick={() => {
              if (password.current) password.current.value = "";
              void run(() => save({ kind: "remove" }));
            }}
          >
            Remove key
          </button>
          <button
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
                await publish(
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
        <button
          disabled={
            disabled ||
            !connection ||
            dirty ||
            (!isLocalBase(connection.base_url) && status !== "present")
          }
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
              props.onModels(connection.id, choices);
              setNotice(
                "Model IDs fetched. Compatibility with each task is unverified.",
              );
            })
          }
        >
          Refresh models
        </button>
        {models.length > 0 && (
          <ul aria-label="Discovered model IDs">
            {models.map((item) => (
              <li key={item.id}>{item.id}</li>
            ))}
          </ul>
        )}
      </fieldset>
      <p className="muted">
        Unassign both tasks before deleting a connection. Saving a connection
        updates every task that uses it.
      </p>
      <div ref={outcome}>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/** Which saved connection and model one task uses. */
export function Assignment({
  role,
  settings,
  disabled,
  models,
  ...publish
}: Publish & {
  role: ProviderRole;
  settings: Settings;
  disabled: boolean;
  /** Fetched model IDs as suggestions, with the connection they came from. */
  models: { connectionId: string; models: ProviderModel[] } | null;
}) {
  const modelListId = useId();
  const assignment = settings.provider_assignments[role];
  const [id, setId] = useState(assignment?.connection_id ?? "");
  const [model, setModel] = useState(assignment?.model ?? "");
  const { busy, notice, error, setNotice, run } = useTask();
  useEffect(() => {
    setId(assignment?.connection_id ?? "");
    setModel(assignment?.model ?? "");
  }, [assignment?.connection_id, assignment?.model]);
  const label = role === "llm" ? "Summary" : "Speech API";
  const save = () =>
    run(async () => {
      await publishSettings(
        await api.saveProviderAssignment(
          role,
          id
            ? { kind: "assigned", connection_id: id, model: model.trim() }
            : { kind: "unassigned" },
          settings[role]?.revision ?? null,
        ),
        publish,
      );
      setNotice("Task assignment saved. No meeting content was sent.");
    });
  const unchanged =
    id === (assignment?.connection_id ?? "") &&
    model.trim() === (assignment?.model ?? "");
  const chosen = settings.saved_connections.find((item) => item.id === id);
  return (
    <fieldset disabled={disabled || busy}>
      <legend>{label} task</legend>
      <label>
        {label} connection
        <select
          value={id}
          onChange={(event) => {
            setId(event.target.value);
            setModel("");
          }}
        >
          <option value="">Unassigned</option>
          {settings.saved_connections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {destination(item.base_url)}
            </option>
          ))}
        </select>
      </label>
      {settings.saved_connections.length === 0 && (
        <p className="muted">Add a connection under Connections first.</p>
      )}
      <label>
        {label} model ID
        <input
          value={model}
          disabled={disabled || busy || !id}
          list={modelListId}
          maxLength={200}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <datalist id={modelListId}>
        {(models?.connectionId === id
          ? modelsFor(models.models, role)
          : []
        ).map((item) => (
          <option key={item.id} value={item.id} />
        ))}
      </datalist>
      <p className="muted">
        {chosen ? `${destination(chosen.base_url)}. ` : ""}Saved model:{" "}
        {assignment?.model ?? "Not selected"}. Model IDs are unverified until
        used successfully.
      </p>
      {!unchanged && (
        <button
          disabled={disabled || busy || (!!id && !model.trim())}
          onClick={() => void save()}
        >
          Save {label.toLowerCase()} assignment
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
