import { useState } from "react";
import { api, errorMessage } from "../../shared/api/api";

type Props = {
  meetingId: string;
  tags: string[];
  disabled: boolean;
  onTags: (tags: string[]) => void;
};

/** Comma-separated tags; the backend trims, dedupes and validates, and the typed text survives a failure. */
export function MeetingTagsForm({ meetingId, tags, disabled, onTags }: Props) {
  const stored = tags.join(", ");
  const [text, setText] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="meeting-tags"
      aria-label="Meeting tags"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        const list = text
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        api
          .setMeetingTags(meetingId, list)
          .then(
            (saved) => {
              setText(saved.join(", "));
              onTags(saved);
            },
            (failure: unknown) => setError(errorMessage(failure)),
          )
          .finally(() => setBusy(false));
      }}
    >
      <input
        aria-label="Tags"
        value={text}
        placeholder="Tags, separated by commas"
        disabled={disabled || busy}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" disabled={disabled || busy || text === stored}>
        Save tags
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
