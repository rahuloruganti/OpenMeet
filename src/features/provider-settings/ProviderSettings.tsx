import { useEffect, useRef, useState } from "react";
import {
  api,
  errorCode,
  errorMessage,
  isLocalBase,
  type KeyChange,
  type KeyStatus,
  type ProviderModel,
  type ProviderRole,
  type SavedConnection,
  type Settings,
} from "../../shared/api/api";
import { modelsFor } from "../../shared/lib/models";
import {
  CUSTOM_PROVIDER,
  freeName,
  presetById,
  presetForUrl,
  presetsFor,
} from "../../shared/lib/providers";
import { hostOf, type Publish } from "../../shared/ui/provider-connection";
import { Saved, useSaved } from "../../shared/ui/settings-link";

// One sentence each, and each says the action that fixes it (TEXT RULES).
const urlFormat = "Use a full URL like https://api.example.com/v1.";
const urlRules =
  "Use https, or http on localhost, without credentials or a query.";

/** The first reason an API base URL cannot be saved, mirroring validate_base_url in domain/providers.py. */
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

/**
 * One sentence for a failed Test: what went wrong and what to do next. Every branch says
 * nothing was saved, because Test only lists models and never stores anything.
 */
export function testFailure(failure: unknown): string {
  switch (errorCode(failure)) {
    case "provider_unauthorized":
      return "Nothing was saved: the provider rejected this key, so check it for typos and Test again.";
    case "provider_unreachable":
      return "Nothing was saved: the address did not answer, so check the URL and your connection, then Test again.";
    case "provider_models":
      return "Nothing was saved: the provider's model list was not usable, so type a model ID under Other… instead.";
    case "provider_rate_limited":
      return "Nothing was saved: the provider is rate limiting, so wait a minute and Test again.";
    default:
      return "Nothing was saved: the check did not finish, so check the URL and key, then Test again.";
  }
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

/** The model menu entry that reveals a free-text model ID. */
const OTHER_MODEL = "__other__";

/** One OpenAI-compatible connection and the task that uses it: keys need an explicit Save. */
export function ConnectionEditor(props: Props) {
  const assignment = props.settings.provider_assignments[props.role];
  const presets = presetsFor(props.role);
  const takenNames = props.settings.saved_connections.map((item) => item.name);
  const [selected, setSelected] = useState(assignment?.connection_id ?? "");
  // Only a new connection picks a provider; a saved one keeps its own URL.
  const [provider, setProvider] = useState(presets[0]?.id ?? CUSTOM_PROVIDER);
  const connection =
    props.settings.saved_connections.find((item) => item.id === selected) ??
    null;
  const [name, setName] = useState("");
  const [model, setModel] = useState(assignment?.model ?? "");
  const [status, setStatus] = useState<KeyStatus>("unavailable");
  // Model IDs belong to one URL, saved revision and key edit, so an older answer never renders.
  const [found, setFound] = useState<{
    scope: string;
    models: ProviderModel[];
    edit: number;
  } | null>(null);
  // Counts key edits, never the key: a Test or model list from before an edit is stale.
  const keyEdits = useRef(0);
  const [keyEpoch, setKeyEpoch] = useState(0);
  const editKey = () => {
    keyEdits.current += 1;
    setKeyEpoch(keyEdits.current);
  };
  const [baseUrl, setBaseUrl] = useState("");
  const scopeOf = (id: string, revision: number | null, url: string) =>
    `${id}|${revision ?? ""}|${url.trim()}`;
  const scope = scopeOf(selected, connection?.revision ?? null, baseUrl);
  const discovered =
    found && found.scope === scope && found.edit === keyEpoch
      ? found.models
      : [];
  // The scope on screen now, so a slow Test answer for an older revision prints nothing.
  const liveScope = useRef(scope);
  liveScope.current = scope;
  // "Other" reveals a text field for a model the provider does not list.
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [keyEntered, setKeyEntered] = useState(false);
  // Delete asks first, inline; Cancel is focused so Enter never deletes by accident.
  const [confirming, setConfirming] = useState(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const { shown, mark } = useSaved();
  const password = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  // Bumped when the user moves on, so a slow model listing cannot land elsewhere.
  const switches = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const preset =
    selected === "" && provider !== CUSTOM_PROVIDER
      ? presetById(provider)
      : null;
  // A saved connection still names the key page its own URL belongs to.
  const keyHint = preset ?? presetForUrl(baseUrl);
  // What a new connection starts with, so an untouched preset is not a draft.
  const draftName = preset ? freeName(preset.label, takenNames) : "";
  const draftUrl = preset?.baseUrl ?? "";
  const connectionDirty = connection
    ? name !== connection.name || baseUrl !== connection.base_url
    : name !== draftName || baseUrl !== draftUrl;
  const assigned = assignment?.connection_id ?? "";
  const selectedConnection = selected === NONE ? null : selected;
  const modelValue = model.trim();
  const disabled = props.disabled || busy;
  const urlError = baseUrlError(baseUrl);
  // A preset brings its own URL, so only a typed URL can still be missing.
  const missingFields = selected === "" && !baseUrl.trim();
  // A new or edited connection saves without a model; the task still needs one.
  const connectionWork =
    selected !== NONE && (selected === "" || connectionDirty || keyEntered);
  const assignmentWork =
    selectedConnection !== assigned ||
    (modelValue !== "" && modelValue !== (assignment?.model ?? ""));
  const canSave =
    !disabled &&
    !missingFields &&
    urlError === null &&
    (connectionWork || assignmentWork);
  // An empty new connection has neither a provider URL nor a typed one: say what is missing.
  const saveReason = missingFields ? "Enter a URL first." : null;
  // One reason per disabled button, shown only for the cause that applies.
  const urlMoved = !!connection && baseUrl.trim() !== connection.base_url;
  const testReason =
    !baseUrl.trim() || urlError
      ? "Enter a valid URL first."
      : keyEntered || isLocalBase(baseUrl)
        ? null
        : urlMoved
          ? "Enter the key for the new URL."
          : status !== "present"
            ? "Enter the API key first."
            : null;
  const [tested, setTested] = useState<{
    scope: string;
    ok: boolean;
    edit: number;
  } | null>(null);
  const testResult =
    tested && tested.scope === scope && tested.edit === keyEpoch
      ? tested
      : null;
  const usable = modelsFor(discovered, props.role);
  const modelListed = usable.some((item) => item.id === model);
  const removeReason =
    !connection || status === "missing"
      ? "No saved key to remove."
      : connectionDirty
        ? "Save the connection first."
        : null;
  // Results render below the card; bring them into view so a long page never hides them, but
  // only while the user works in this editor: a status found on load must not scroll the page.
  const outcome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = outcome.current;
    const scope = box?.closest(".om-group") ?? box?.parentElement;
    if ((notice || error) && scope?.contains(document.activeElement))
      box?.scrollIntoView?.({ block: "nearest" });
  }, [notice, error]);
  useEffect(() => {
    if (password.current) password.current.value = "";
    setName(connection?.name ?? (selected === "" ? draftName : ""));
    setBaseUrl(connection?.base_url ?? (selected === "" ? draftUrl : ""));
    setKeyEntered(false);
    setTyping(false);
    setConfirming(false);
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
    provider,
    selected,
  ]);
  // The saved model follows the assignment, so a save elsewhere is not overwritten.
  useEffect(() => {
    setModel(assignment?.model ?? "");
  }, [assignment?.model]);
  useEffect(() => {
    const field = password.current;
    if (!props.active && field) {
      field.value = "";
      keyEdits.current += 1;
      setKeyEpoch(keyEdits.current);
    }
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
    editKey();
    switches.current += 1;
    // A new connection starts on the first provider that serves this task.
    if (id === "") setProvider(presets[0]?.id ?? CUSTOM_PROVIDER);
    setSelected(id);
    setError("");
    setNotice("");
  };
  const changeProvider = (id: string) => {
    if (password.current) password.current.value = "";
    editKey();
    switches.current += 1;
    setProvider(id);
    setError("");
    setNotice("");
  };
  useEffect(() => {
    if (confirming) cancelDelete.current?.focus();
  }, [confirming]);
  const save = () =>
    run(async () => {
      const key = password.current?.value ?? "";
      if (password.current) password.current.value = "";
      const attempt = switches.current;
      let settings = props.settings;
      let connectionId: string | null = selected === NONE ? null : selected;
      let saved: SavedConnection | null = null;
      let keyStatus: KeyStatus = status;
      if (
        connectionId !== null &&
        (connectionDirty || connectionId === "" || key !== "")
      ) {
        // A blank name falls back to where the connection sends data.
        const connectionName = name.trim() || hostOf(baseUrl);
        settings = await api.saveApiConnection({
          id: connection?.id ?? null,
          name: connectionName,
          baseUrl: baseUrl.trim(),
          keyChange: key ? { kind: "replace", key } : { kind: "keep" },
          expectedRevision: connection?.revision ?? null,
        });
        saved =
          settings.saved_connections.find((item) =>
            connectionId
              ? item.id === connectionId
              : item.name === connectionName &&
                item.base_url === baseUrl.trim(),
          ) ?? null;
        connectionId = saved?.id ?? null;
        if (saved) {
          keyStatus = await api
            .apiConnectionKeyStatus(saved.id)
            .catch(() => "unavailable" as const);
          setSelected(saved.id);
          setStatus(keyStatus);
        }
        publish(settings);
      }
      // The model staged by Test, or else the first one the provider lists (the same rule
      // Test uses), so one Save stores the connection and the task together.
      let chosen = modelValue;
      if (connectionId !== null && chosen === "") {
        const listTarget = saved ?? connection;
        if (!listTarget) return;
        setKeyEntered(false);
        mark();
        // Without a key there is nothing to list; the card already says why.
        if (!isLocalBase(listTarget.base_url) && keyStatus === "missing") {
          setNotice("Saved. Add the key, then Test to load models.");
          return;
        }
        try {
          // Read after the save above, so this listing's own publication is not stale.
          const edit = keyEdits.current;
          const listed = await api.listApiConnectionModels(
            listTarget.id,
            listTarget.revision,
          );
          if (
            !alive.current ||
            switches.current !== attempt ||
            keyEdits.current !== edit
          )
            return;
          setFound({
            scope: scopeOf(
              listTarget.id,
              listTarget.revision,
              listTarget.base_url,
            ),
            models: listed,
            edit,
          });
          chosen = modelsFor(listed, props.role)[0]?.id ?? "";
          setModel(chosen);
        } catch (failure) {
          if (!alive.current || switches.current !== attempt) return;
          setNotice("");
          setError(errorMessage(failure));
          return;
        }
        if (chosen === "") {
          setNotice("Saved. Pick a model to finish.");
          return;
        }
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
        chosen !== (target?.model ?? "")
      ) {
        settings = await api.saveProviderAssignment(
          props.role,
          {
            kind: "assigned",
            connection_id: connectionId,
            model: chosen,
          },
          target?.revision ?? null,
        );
      }
      publish(settings);
      setKeyEntered(false);
      mark();
      setNotice("Saved on this device. No meeting content was sent.");
    });
  const testConnection = () =>
    run(async () => {
      const key = password.current?.value.trim() ?? "";
      const attempt = switches.current;
      const edit = keyEdits.current;
      const target = scope;
      try {
        const listed = await api.testApiConnection(
          baseUrl.trim(),
          key || null,
          connection?.id ?? null,
        );
        // A key edit, a switch or an unmount makes this answer stale: it prints nothing.
        if (
          !alive.current ||
          switches.current !== attempt ||
          keyEdits.current !== edit
        )
          return;
        setFound({ scope: target, models: listed, edit });
        setTested({ scope: target, ok: true, edit });
        if (liveScope.current !== target) return;
        const offered = modelsFor(listed, props.role);
        if (modelValue === "" && offered[0]) setModel(offered[0].id);
        setNotice(
          `Working. ${offered.length} model${offered.length === 1 ? "" : "s"} found; nothing was saved.`,
        );
      } catch (failure) {
        // A failure for a key that was since replaced says nothing about the key now typed.
        if (keyEdits.current !== edit) return;
        if (alive.current && switches.current === attempt)
          setTested({ scope: target, ok: false, edit });
        throw new Error(testFailure(failure), { cause: failure });
      }
    });

  const label = props.role === "llm" ? "AI notes" : "Transcription";
  return (
    <section className="provider-settings" aria-label={`${label} connection`}>
      <div className="om-card om-rows">
        {selected === "" && (
          <div className="om-row">
            <div className="om-what">
              <strong>Provider</strong>
            </div>
            <div className="om-side">
              <select
                aria-label="Provider"
                value={provider}
                disabled={disabled}
                onChange={(event) => changeProvider(event.target.value)}
              >
                {presets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
                <option value={CUSTOM_PROVIDER}>Custom</option>
              </select>
              {preset && (
                <span
                  className="om-muted"
                  style={{ fontFamily: "var(--mono)" }}
                >
                  {hostOf(preset.baseUrl)}
                </span>
              )}
            </div>
          </div>
        )}
        <div className="om-row">
          <div className="om-what">
            <strong>Connection</strong>
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
                  {item.name}
                </option>
              ))}
              <option value={NONE}>No connection</option>
            </select>
          </div>
        </div>
        {(selected !== "" || !preset) && (
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
        )}
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
              placeholder={keyHint ? `Key from ${keyHint.keyPage}` : undefined}
              onChange={() => {
                setKeyEntered(true);
                setNotice("");
                editKey();
              }}
            />
            <button
              type="button"
              className="om-ghost om-sm"
              disabled={disabled || selected === NONE || testReason !== null}
              title={testReason ?? "Checks the URL and key by listing models"}
              aria-busy={busy}
              onClick={() => void testConnection()}
            >
              Test
            </button>
            {testResult ? (
              testResult.ok ? (
                <span className="om-saved">Working</span>
              ) : (
                <span className="om-error">Not working</span>
              )
            ) : status === "present" ? (
              <span className="om-saved">
                Key saved. Type a new key to replace it.
              </span>
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
            <select
              aria-label="Model"
              className="om-mono"
              value={typing ? OTHER_MODEL : model}
              disabled={disabled || selected === NONE}
              onChange={(event) => {
                const value = event.target.value;
                setTyping(value === OTHER_MODEL);
                if (value !== OTHER_MODEL) setModel(value);
              }}
            >
              {model === "" && !typing && (
                <option value="" disabled>
                  {usable.length > 0 ? "Choose a model" : "Test to load models"}
                </option>
              )}
              {model !== "" && !modelListed && (
                <option value={model}>{model}</option>
              )}
              {usable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
              <option value={OTHER_MODEL}>Other…</option>
            </select>
            {typing && (
              <input
                aria-label="Model ID"
                className="om-mono"
                value={model}
                maxLength={200}
                placeholder="model-id"
                disabled={disabled || selected === NONE}
                onChange={(event) => setModel(event.target.value)}
              />
            )}
          </div>
        </div>
      </div>
      <div className="om-card-foot">
        <button
          type="button"
          className="om-sm"
          disabled={!canSave}
          title={canSave ? undefined : (saveReason ?? undefined)}
          onClick={() => void save()}
        >
          Save
        </button>
        <span className="om-spacer" />
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
          {missingFields && <p className="om-muted">Enter a URL.</p>}
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
            {confirming && connection ? (
              <div
                className="om-side"
                role="group"
                aria-label="Confirm delete"
                onKeyDown={(event) => {
                  // Esc cancels here and never reaches the page's own Esc (go back).
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  setConfirming(false);
                }}
              >
                <span className="om-muted">
                  {`Delete ${connection.name}? Its key is removed too.`}
                </span>
                <button
                  ref={cancelDelete}
                  type="button"
                  className="om-ghost om-sm"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="om-sm om-danger"
                  disabled={disabled}
                  onClick={() =>
                    void run(async () => {
                      if (!connection) return;
                      publish(
                        await api.deleteApiConnection(
                          connection.id,
                          connection.revision,
                        ),
                      );
                      setConfirming(false);
                      switches.current += 1;
                      setProvider(presets[0]?.id ?? CUSTOM_PROVIDER);
                      setSelected("");
                    })
                  }
                >
                  Delete
                </button>
              </div>
            ) : (
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
                onClick={() => setConfirming(true)}
              >
                Delete connection
              </button>
            )}
          </div>
        </div>
      </details>
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
