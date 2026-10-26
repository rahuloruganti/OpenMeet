import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CallLifecycle } from "../../shared/api/api";

/** Before the first read lands: nothing is recording and nothing is armed. */
export const idleLifecycle: CallLifecycle = {
  state: "disabled",
  enabled: false,
  session_id: null,
  meeting_id: null,
  app_name: null,
  origin: null,
  revision: 0,
  reason: "",
  end_deadline_ms: null,
  error: null,
};

/**
 * Automatic capture state from the backend. The backend owns it: the hook reads it on mount and
 * again on every lifecycle event, and never trusts an event payload on its own.
 */
export function useCallLifecycle(): {
  lifecycle: CallLifecycle;
  refresh: () => Promise<void>;
} {
  const [lifecycle, setLifecycle] = useState<CallLifecycle>(idleLifecycle);
  // Only the newest read may land, so a slow older read cannot overwrite a newer state.
  const issued = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++issued.current;
    try {
      const next = await api.getCallLifecycle();
      if (next && id === issued.current) setLifecycle(next);
    } catch {
      // Not connected (plain browser tab) or a failed read: keep the last state shown.
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void refresh();
    const subscribe = async () => {
      const stop = await api.onCallLifecycleChanged(() => {
        void refresh();
      });
      if (disposed) stop?.();
      else unlisten = stop;
    };
    subscribe().catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  return { lifecycle, refresh };
}
