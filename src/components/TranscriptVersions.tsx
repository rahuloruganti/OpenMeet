import { useState } from "react";
import {
  api,
  errorMessage,
  speakerLabel,
  type Segment,
  type SpeakerNames,
  type TranscriptVersion,
} from "../lib/api";

type Props = {
  meetingId: string;
  versions: TranscriptVersion[];
  names: SpeakerNames;
};

/** Read-only view of transcripts kept before a re-transcription replaced them. */
export function TranscriptVersions({ meetingId, versions, names }: Props) {
  const [chosen, setChosen] = useState("");
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [error, setError] = useState("");
  if (versions.length === 0) return null;
  const choose = (value: string) => {
    setChosen(value);
    setSegments(null);
    setError("");
    if (!value) return;
    api.getTranscriptVersion(meetingId, Number(value)).then(
      (loaded) => setSegments(loaded),
      (failure: unknown) => setError(errorMessage(failure)),
    );
  };
  return (
    <div className="transcript-versions">
      <label>
        Earlier transcripts{" "}
        <select value={chosen} onChange={(event) => choose(event.target.value)}>
          <option value="">Hide earlier transcripts</option>
          {versions.map((version, index) => (
            <option key={version.id} value={version.id}>
              {`Earlier transcript ${versions.length - index} · ${version.provider ?? "unknown engine"}${version.model ? ` / ${version.model}` : ""} · ${version.segment_count} segments${version.edited ? " · edited" : ""}`}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {segments && (
        <section aria-label="Earlier transcript (read-only)">
          <p className="muted">
            Read-only copy kept before a later transcription replaced it.
          </p>
          {segments.map((segment, index) => (
            <p className="transcript-segment" key={index}>
              <strong>{speakerLabel(names, segment.speaker)}</strong>{" "}
              <span className="muted">
                {segment.timing.kind === "timed"
                  ? `${(segment.timing.start_ms / 1000).toFixed(1)}s`
                  : "Untimed"}
              </span>{" "}
              — {segment.text}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
