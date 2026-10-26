import type { LocalAiJob } from "../../shared/api/api";

/** A download or setup in flight: how far it is, and the way to stop it. */
export function ProgressJob(props: {
  job: LocalAiJob;
  label: string;
  cancelLabel: string;
  onCancel: () => void;
}) {
  return (
    <span className="lai-job">
      <progress
        className="lai-bar"
        aria-label={props.label}
        value={props.job.downloaded}
        max={props.job.total > 0 ? props.job.total : undefined}
      />
      <button
        type="button"
        className="om-ghost om-sm"
        aria-label={props.cancelLabel}
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </span>
  );
}
