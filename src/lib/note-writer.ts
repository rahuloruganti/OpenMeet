// Serialize saves so a slower older write cannot replace newer notes.
export function createNoteWriter(
  initial: string,
  initialRevision: number,
  save: (text: string, revision: number) => Promise<number>,
  onStatus: (status: "saved" | "saving" | "error", error?: unknown) => void,
) {
  let desired = initial;
  let persisted = initial;
  let revision = initialRevision;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    if (pending) return pending;
    pending = (async () => {
      while (desired !== persisted) {
        const snapshot = desired;
        onStatus("saving");
        revision = await save(snapshot, revision);
        persisted = snapshot;
      }
      onStatus("saved");
    })()
      .catch((error: unknown) => {
        onStatus("error", error);
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  return {
    update(text: string) {
      desired = text;
      onStatus("saving");
      clearTimeout(timer);
      timer = setTimeout(() => {
        void flush().catch(() => {});
      }, 400);
    },
    flush,
    isDirty: () => desired !== persisted,
    dispose: () => clearTimeout(timer),
  };
}
