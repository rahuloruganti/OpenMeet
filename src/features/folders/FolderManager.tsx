import { useState } from "react";
import { api, errorMessage, type Folder } from "../../shared/api/api";
import {
  IconArrowDown,
  IconArrowUp,
  IconPencil,
  IconTrash,
} from "../../shared/ui/icons";
import "./folders.css";

type Props = {
  folders: Folder[];
  disabled: boolean;
  /** Runs after every successful change; the owner reloads its folder list. */
  onChanged: () => void;
};

/** Create, rename, delete and reorder folders. Delete asks once, inline; nothing is a browser dialog. */
export function FolderManager({ folders, disabled, onChanged }: Props) {
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await action();
      done?.();
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, step: -1 | 1) => {
    const ids = folders.map((folder) => folder.id);
    const target = index + step;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(() => api.reorderFolders(ids));
  };

  const busyOrOff = busy || disabled;

  return (
    <section className="folder-manager" aria-label="Folders">
      <form
        className="folder-new"
        onSubmit={(event) => {
          event.preventDefault();
          const clean = name.trim();
          if (clean)
            void run(
              () => api.createFolder(clean),
              () => setName(""),
            );
        }}
      >
        <label htmlFor="folder-manager-new">New folder</label>
        <input
          id="folder-manager-new"
          value={name}
          maxLength={60}
          disabled={busyOrOff}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={busyOrOff || !name.trim()}>
          Add folder
        </button>
      </form>
      {folders.length === 0 && <p className="muted">No folders yet.</p>}
      <ul aria-label="Folder order">
        {folders.map((folder, index) => (
          <li key={folder.id} className="folder-row">
            {renaming?.id === folder.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const clean = renaming.name.trim();
                  if (clean)
                    void run(
                      () => api.renameFolder(folder.id, clean),
                      () => setRenaming(null),
                    );
                }}
              >
                <input
                  aria-label={`Rename ${folder.name}`}
                  value={renaming.name}
                  maxLength={60}
                  disabled={busyOrOff}
                  onChange={(event) =>
                    setRenaming({ id: folder.id, name: event.target.value })
                  }
                />
                <button
                  type="submit"
                  disabled={busyOrOff || !renaming.name.trim()}
                >
                  Save
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRenaming(null)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="folder-name">{folder.name}</span>
                <span className="muted">{folder.meeting_count} meetings</span>
                <button
                  type="button"
                  className="folder-icon"
                  aria-label={`Move ${folder.name} up`}
                  title={`Move ${folder.name} up`}
                  disabled={busyOrOff || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <IconArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="folder-icon"
                  aria-label={`Move ${folder.name} down`}
                  title={`Move ${folder.name} down`}
                  disabled={busyOrOff || index === folders.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <IconArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="folder-icon"
                  aria-label="Rename"
                  title={`Rename ${folder.name}`}
                  disabled={busyOrOff}
                  onClick={() =>
                    setRenaming({ id: folder.id, name: folder.name })
                  }
                >
                  <IconPencil size={14} />
                </button>
                <button
                  type="button"
                  className="folder-icon folder-danger"
                  aria-label={`Delete ${folder.name}`}
                  title={`Delete ${folder.name}`}
                  disabled={busyOrOff}
                  onClick={() => setDeleting(folder.id)}
                >
                  <IconTrash size={14} />
                </button>
              </>
            )}
            {deleting === folder.id && (
              <div
                className="folder-confirm"
                role="group"
                aria-label={`Delete ${folder.name}`}
              >
                <p>
                  Delete <strong>{folder.name}</strong>? Its meetings stay.
                </p>
                <button
                  type="button"
                  className="folder-danger"
                  disabled={busyOrOff}
                  onClick={() =>
                    void run(
                      () => api.deleteFolder(folder.id),
                      () => setDeleting(null),
                    )
                  }
                >
                  Delete folder
                </button>
                <button
                  type="button"
                  className="folder-action"
                  disabled={busy}
                  onClick={() => setDeleting(null)}
                >
                  Keep
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
