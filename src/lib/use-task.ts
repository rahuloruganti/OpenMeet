import { useState } from "react";
import { errorMessage } from "./api";

/** Runs one task with a busy flag; a failure becomes the error text. */
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, setError, setNotice, run };
}
