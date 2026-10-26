import { useId } from "react";

type Readiness = {
  hasTranscript: boolean;
  hasNotes: boolean;
  modelReady: boolean;
  recording: boolean;
};

/** Why Enhance notes is off, as one short line; null when it can run. Recording is named first. */
export function enhanceBlockReason({
  hasTranscript,
  hasNotes,
  modelReady,
  recording,
}: Readiness): string | null {
  if (recording) return "Stop recording to enhance your notes.";
  if (!hasTranscript) return "No transcript yet. Record or transcribe first.";
  if (!hasNotes) return "Write notes first.";
  if (!modelReady) return "Set up AI notes in Settings first.";
  return null;
}

type Props = Readiness & {
  /** The template the enhancement uses; the workspace template picker owns it. */
  template: string;
  /** "Enhance notes" first, "Regenerate" once enhanced notes exist. */
  label: string;
  busy: boolean;
  onEnhance: (template: string) => void;
};

export function EnhanceNotesButton(props: Props) {
  const reason = enhanceBlockReason(props);
  const hintId = useId();
  return (
    <>
      <button
        type="button"
        disabled={reason !== null || props.busy}
        aria-describedby={reason === null ? undefined : hintId}
        onClick={() => props.onEnhance(props.template)}
      >
        {props.busy ? "Enhancing…" : props.label}
      </button>
      {reason !== null && (
        <span id={hintId} className="mw-hint">
          {reason}
        </span>
      )}
    </>
  );
}
