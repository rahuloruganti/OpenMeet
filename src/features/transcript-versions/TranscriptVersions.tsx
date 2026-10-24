import { useState } from "react";
import {
  api,
  errorMessage,
  speakerLabel,
  type Segment,
  type SpeakerNames,
  type TranscriptVersion,
} from "../../shared/api/api";
import { formatTimestamp } from "../../shared/lib/timestamps";
import "./transcript-versions.css";

type Props = {
  meetingId: string;
  /** Earlier transcripts, newest first. */
  versions: TranscriptVersion[];
  names: SpeakerNames;
};

/** History sheet body: transcripts kept before a re-transcription replaced them, read-only. */
export function TranscriptVersions({ meetingId, versions, names }: Props) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [error, setError] = useState("");
  if (versions.length === 0)
    return <p className="insp-empty">No earlier transcripts</p>;
  const view = (id: number) => {
    if (chosen === id) {
      setChosen(null);
      return;
    }
    setChosen(id);
    setSegments(null);
    setError("");
    api.getTranscriptVersion(meetingId, id).then(
      (loaded) => setSegments(loaded),
      (failure: unknown) => setError(errorMessage(failure)),
    );
  };
  return (
    <div className="ver-list">
      {versions.map((version, index) => (
        <div className="ver" key={version.id}>
          <div className="ver-top">
            <span className="ver-name">
              {version.provider ?? "Unknown engine"}
              {version.model ? ` · ${version.model}` : ""}
            </span>
            {version.edited && <span className="tag">Edited</span>}
            <button
              className="ver-go"
              aria-label={`Earlier transcript ${versions.length - index}`}
              aria-expanded={chosen === version.id}
              onClick={() => view(version.id)}
            >
              {chosen === version.id ? "Hide" : "View"}
            </button>
          </div>
          <span className="ver-sub">{`${version.segment_count} segments${
            index === 0 ? " · previous" : ""
          }`}</span>
          {chosen === version.id && segments && (
            <div
              className="ver-body"
              role="group"
              aria-label="Earlier transcript (read-only)"
            >
              {segments.map((segment, at) => (
                <p className="transcript-segment" key={at}>
                  <strong>{speakerLabel(names, segment.speaker)}</strong>{" "}
                  <span className="muted">
                    {segment.timing.kind === "timed"
                      ? formatTimestamp(segment.timing.start_ms)
                      : "Untimed"}
                  </span>{" "}
                  — {segment.text}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
