import { useState } from "react";
import { api, errorMessage, type SpeakerNames } from "../../shared/api/api";

type Props = {
  meetingId: string;
  names: SpeakerNames;
  disabled: boolean;
  onNames: (names: SpeakerNames) => void;
};

/** Display names for the two track labels; the stored labels still pick the audio track. */
export function SpeakerNamesForm({
  meetingId,
  names,
  disabled,
  onNames,
}: Props) {
  const [you, setYou] = useState(names.you ?? "");
  const [others, setOthers] = useState(names.others ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = you !== (names.you ?? "") || others !== (names.others ?? "");
  return (
    <form
      className="speaker-names"
      aria-label="Speaker names"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        api
          .saveSpeakerNames(meetingId, you || null, others || null)
          .then(onNames, (failure: unknown) => setError(errorMessage(failure)))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        Name for You (microphone)
        <input
          value={you}
          maxLength={80}
          placeholder="You"
          disabled={disabled || busy}
          onChange={(event) => setYou(event.target.value)}
        />
      </label>
      <label>
        Name for Others (system audio)
        <input
          value={others}
          maxLength={80}
          placeholder="Others"
          disabled={disabled || busy}
          onChange={(event) => setOthers(event.target.value)}
        />
      </label>
      <p className="muted">
        Others is all system audio and may include several people. Names are
        added to the transcript text sent for summaries and questions.
      </p>
      <button type="submit" disabled={disabled || busy || !changed}>
        Save speaker names
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
