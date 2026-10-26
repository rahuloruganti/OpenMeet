import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Folder } from "../../shared/api/api";

export type FoldersState = {
  folders: Folder[];
  error: string;
  /** Re-reads the list; call after any folder change made from this view. */
  reload: () => Promise<void>;
};

/**
 * The folder list in saved order. It loads on mount and whenever `refreshKey` changes, so a
 * parent can pass a value that changes when meetings change. A stale response never wins.
 */
export function useFolders(refreshKey = ""): FoldersState {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const current = ++latest.current;
    try {
      const rows = await api.listFolders();
      if (current !== latest.current) return;
      setFolders(rows ?? []);
      setError("");
    } catch (failure) {
      if (current === latest.current) setError(errorMessage(failure));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  return { folders, error, reload };
}
