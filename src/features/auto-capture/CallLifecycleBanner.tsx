import { useEffect, useState } from "react";
import { api, errorMessage, type CallLifecycle } from "../../shared/api/api";
import { useCallLifecycle } from "./useCallLifecycle";
import "./auto-capture.css";

/** "mm:ss" for a countdown; the minutes field grows past 99 without wrapping. */
export const countdown = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

const isStaleRevision = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "stale_revision";

/**
 * Compact automatic-capture strip for the recording bar. It shows only states the user must
 * know about: automatic recording, its pause, the end countdown, the transcript finish and an
 * error. Manual recordings and idle or armed states render nothing; the recording bar covers them.
 */
export function CallLifecycleBanner() {
  const { lifecycle, refresh } = useCallLifecycle();
  switch (lifecycle.state) {
    case "recording":
      return lifecycle.origin === "auto" ? (
        <Strip>
          {`Recording automatically${lifecycle.app_name ? ` · ${lifecycle.app_name}` : ""}`}
        </Strip>
      ) : null;
    case "paused":
      return lifecycle.origin === "auto" ? (
        <Strip>Automatic recording paused</Strip>
      ) : null;
    case "end_pending":
      return <EndPending lifecycle={lifecycle} refresh={refresh} />;
    case "finalizing":
      return <Strip>Finishing transcript...</Strip>;
    case "recoverable_error":
      return (
        <span className="error" role="alert">
          {lifecycle.error ?? "Automatic capture stopped with an error."}
        </span>
      );
    default:
      return null;
  }
}

function Strip({ children }: { children: string }) {
  return (
    <span className="call-life" aria-live="polite">
      {children}
    </span>
  );
}

function EndPending({
  lifecycle,
  refresh,
}: {
  lifecycle: CallLifecycle;
  refresh: () => Promise<void>;
}) {
  const deadline = lifecycle.end_deadline_ms;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const remaining = deadline === null ? 0 : Math.max(0, deadline - now);
  const expired = deadline !== null && remaining === 0;

  // Ticks once a second while the countdown runs; the deadline is the single source of time.
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  // The backend ends the capture at the deadline; re-read once in case its event was missed.
  useEffect(() => {
    if (expired) void refresh();
  }, [expired, refresh]);

  const sessionId = lifecycle.session_id;
  const runAction = async (
    request: (id: string, revision: number) => Promise<CallLifecycle>,
  ) => {
    if (sessionId === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await request(sessionId, lifecycle.revision);
    } catch (error) {
      // A newer state already landed; show it instead of the stale request.
      if (!isStaleRevision(error)) setFailure(errorMessage(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <>
      <span className="call-life call-life-end">
        <span>{`Call seems to have ended. Recording ends in ${countdown(remaining)}`}</span>
        <span className="call-life-acts">
          <button
            type="button"
            disabled={busy || sessionId === null}
            onClick={() =>
              void runAction((id, revision) =>
                api.lifecycleKeepRecording(id, revision),
              )
            }
          >
            Keep recording
          </button>
          <button
            type="button"
            disabled={busy || sessionId === null}
            onClick={() =>
              void runAction((id, revision) =>
                api.lifecycleEndNow(id, revision),
              )
            }
          >
            End now
          </button>
        </span>
      </span>
      {failure && (
        <span className="error" role="alert">
          {failure}
        </span>
      )}
    </>
  );
}
