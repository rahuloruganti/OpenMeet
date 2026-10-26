import { useState } from "react";
import { api, errorMessage, type Meeting } from "../../shared/api/api";
import { FolderPicker } from "./FolderPicker";
import { useFolders } from "./useFolders";
import "./folders.css";

type Props = {
  meetingId: string;
  folderId: string | null;
  disabled: boolean;
  /** The meeting as the backend now holds it. */
  onMoved?: (meeting: Meeting) => void;
};

/** The meeting menu's "Move to folder": a folder picker that files the meeting when chosen. */
export function MoveToFolder({
  meetingId,
  folderId,
  disabled,
  onMoved,
}: Props) {
  const folders = useFolders();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const move = (target: string | null) => {
    setBusy(true);
    setError("");
    api
      .moveMeetingToFolder(meetingId, target)
      .then(
        (meeting) => onMoved?.(meeting),
        (failure: unknown) => setError(errorMessage(failure)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="folder-move">
      <FolderPicker
        label="Move to folder"
        folders={folders.folders}
        value={folderId}
        disabled={disabled || busy}
        onChoose={move}
        onCreated={() => void folders.reload()}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
