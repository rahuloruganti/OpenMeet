import type { LocalAiJob } from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";

/** A download or setup in flight: how far it is, and the way to stop it. */
export function ProgressJob(props: {
  job: LocalAiJob;
  label: string;
  cancelLabel: string;
  onCancel: () => void;
}) {
  const percent =
    props.job.total > 0
      ? Math.min(
          100,
          Math.round((props.job.downloaded / props.job.total) * 100),
        )
      : null;
  return (
    <span className="lai-job">
      <progress
        className="lai-bar"
        aria-label={props.label}
        value={props.job.downloaded}
        max={props.job.total > 0 ? props.job.total : undefined}
      />
      <span className="lai-job-text">
        {percent === null ? formatBytes(props.job.downloaded) : `${percent}%`}
      </span>
      <button
        type="button"
        className="om-ghost om-sm lai-cancel"
        aria-label={props.cancelLabel}
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </span>
  );
}
