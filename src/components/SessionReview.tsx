import type { SessionDestination, SessionProcessingPlan } from "../lib/api";

function destination(value: SessionDestination) {
  return value.kind === "local_whisper"
    ? `Local Whisper (${value.model}), on this device`
    : `${value.base_url}, model ${value.model}`;
}

export function SessionReview({
  plan,
  confirmed,
  onConfirm,
}: {
  plan: SessionProcessingPlan;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
}) {
  const final = plan.scope.kind === "final" ? plan.scope : null;
  return (
    <section aria-label="Processing review" className="processing-review">
      <h3>Review automatic processing</h3>
      <p>Speech destination: {destination(plan.scope.speech)}.</p>
      <p>
        Scope:{" "}
        {final
          ? final.live
            ? "live transcription and final transcription"
            : "final transcription"
          : "live transcription only"}
        . Tracks: {plan.tracks.join(", ")}. Language: {plan.language}.
      </p>
      {final?.summary && (
        <p>
          Automatic summary: {destination(final.summary.destination)}, template{" "}
          {final.summary.template}. Saved notes and the final transcript will be
          included.
          {final.summary.instructions
            ? " Your saved summary instructions will also be sent."
            : ""}
          {plan.meeting_id
            ? " The new summary becomes current; earlier versions, including your edits, stay in history. If the transcript is redone, the current one is kept as an earlier transcript."
            : ""}
        </p>
      )}
      <p>
        {plan.meeting_id
          ? "This authorizes processing the existing recording"
          : "This authorizes future recorded audio"}
        {final?.summary ? " and saved notes" : ""} for this session. Cloud
        destinations receive this content.{" "}
        {plan.meeting_id
          ? "This retry starts no recording. Earlier requests may already have been billed; repeating a request may incur another charge."
          : "Live and final transcription make separate requests and may incur separate charges. Audio captured before pausing may finish processing while paused. Paused audio is excluded."}
      </p>
      <p>
        Limits: {plan.limits.duration_seconds} seconds of recording,{" "}
        {plan.limits.post_stop_seconds} seconds of processing{" "}
        {plan.meeting_id ? "for this retry" : "after stop"},{" "}
        {plan.limits.requests} requests, {plan.limits.upload_bytes} uploaded
        audio bytes and {plan.limits.text_bytes} UTF-8 text bytes. Processing
        stops when a limit is reached. No automatic retries.
      </p>
      <p>
        Review expires{" "}
        {new Date(plan.review_expires_at * 1000).toLocaleString()}. Cancelling
        cannot recall content already sent.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirm(event.target.checked)}
        />
        I authorize this processing scope and these destinations and limits.
      </label>
    </section>
  );
}
