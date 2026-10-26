import { useId, useState } from "react";
import { api, errorMessage, type Folder } from "../../shared/api/api";
import "./folders.css";

const NO_FOLDER = "";
const NEW_FOLDER = "__new__";

type Props = {
  label: string;
  folders: Folder[];
  /** The folder the meeting is in, or null for none. */
  value: string | null;
  disabled: boolean;
  /** "No folder" passes null. */
  onChoose: (folderId: string | null) => void;
  /** Runs after a folder is created, so the owner can reload its list. */
  onCreated: () => void;
};

/** A folder select with "No folder" first and "New folder" last; "New folder" reveals a name field. */
export function FolderPicker(props: Props) {
  const { folders, value, disabled } = props;
  const selectId = useId();
  const nameId = useId();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const cancel = () => {
    setCreating(false);
    setName("");
    setError("");
  };

  const create = async () => {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    setError("");
    try {
      const rows = await api.createFolder(clean);
      const made = rows.find(
        (row) => row.name.toLocaleLowerCase() === clean.toLocaleLowerCase(),
      );
      cancel();
      props.onCreated();
      if (made) props.onChoose(made.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="folder-pick">
      <label htmlFor={selectId}>{props.label}</label>
      <select
        id={selectId}
        value={creating ? NEW_FOLDER : (value ?? NO_FOLDER)}
        disabled={disabled || busy}
        onChange={(event) => {
          const next = event.target.value;
          if (next === NEW_FOLDER) {
            setCreating(true);
            setError("");
            return;
          }
          setCreating(false);
          props.onChoose(next === NO_FOLDER ? null : next);
        }}
      >
        <option value={NO_FOLDER}>No folder</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
        <option value={NEW_FOLDER}>New folder</option>
      </select>
      {creating && (
        <form
          className="folder-new"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label htmlFor={nameId}>Folder name</label>
          <input
            id={nameId}
            value={name}
            maxLength={60}
            autoFocus
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            Create
          </button>
          <button type="button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
