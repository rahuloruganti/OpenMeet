import { useEffect, useId, useState } from "react";
import {
  api,
  type ProviderModel,
  type ProviderRole,
  type Settings,
} from "../api/api";
import { modelsFor } from "../lib/models";
import { useTask } from "../lib/use-task";
import {
  destination,
  publishSettings,
  type Publish,
} from "./provider-connection";

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
  const label = role === "llm" ? "AI notes" : "Speech to text";
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
      <legend>{label}</legend>
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
          Save {role === "llm" ? "AI notes" : "speech to text"} assignment
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
