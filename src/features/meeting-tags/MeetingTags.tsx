import { useState } from "react";
import { api, errorMessage } from "../../shared/api/api";
import "./meeting-tags.css";

type Props = {
  meetingId: string;
  tags: string[];
  disabled: boolean;
  onTags: (tags: string[]) => void;
};

/** Tags shown as chips, edited as one comma-separated field; a failed save keeps the text. */
export function MeetingTagsForm({ meetingId, tags, disabled, onTags }: Props) {
  const stored = tags.join(", ");
  const [text, setText] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="tags"
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
      {tags.length > 0 && (
        <span className="tagchips">
          {tags.map((name) => (
            <span className="tag" key={name}>
              {name}
            </span>
          ))}
        </span>
      )}
      <span className="tags-edit">
        <input
          aria-label="Tags"
          value={text}
          placeholder="Add tags"
          disabled={disabled || busy}
          onChange={(event) => setText(event.target.value)}
        />
        {text !== stored && (
          <button type="submit" disabled={disabled || busy}>
            Save tags
          </button>
        )}
      </span>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
