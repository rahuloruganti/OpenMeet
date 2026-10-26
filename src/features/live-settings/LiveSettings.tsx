import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type LiveModel,
  type LiveModelProgress,
  type LiveModels,
  type Settings,
} from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";
import { IconDownload } from "../../shared/ui/icons";
import { Saved, useSaved } from "../../shared/ui/settings-link";
import "./live-settings.css";

type Props = {
  settings: Settings | null;
  disabled: boolean;
  /** The saved settings a live change returns, so the rest of the page sees the new choice. */
  onSaved?: (settings: Settings) => void;
};

const SAME = "Same as Transcription";
/** Shown for Same while Transcription is cloud: it would have to upload live audio. */
const SAME_CLOUD_REASON =
  "Transcription is cloud, so Same cannot run live here. Choose Cloud connection, or a model on this PC.";

/** "(download 55 MB)" for a pinned model that is not on this PC yet. */
const optionLabel = (model: LiveModel) =>
  model.installed || model.download_bytes === null
    ? model.label
    : `${model.label} (download ${formatBytes(model.download_bytes)})`;

const running = (progress: LiveModelProgress | null) =>
  progress !== null &&
  (progress.stage === "downloading" || progress.stage === "verifying");

/**
 * Settings > Recording > Live transcript: the engine to run and the one explicit download of a
 * pinned streaming model. The live text itself is always on. Model status is read when this panel
 * mounts, which is when Settings opens; nothing is downloaded until Download is clicked.
 */
export function LiveSettings({ settings, disabled, onSaved }: Props) {
  const [models, setModels] = useState<LiveModels | null>(null);
  const [progress, setProgress] = useState<LiveModelProgress | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(settings?.live_model ?? "");
  const { shown, mark } = useSaved();
  const mounted = useRef(true);

  // Settings can arrive after the first render, and other panels can change them.
  useEffect(() => {
    setChosen(settings?.live_model ?? "");
  }, [settings?.live_model]);

  const refresh = useCallback(
    () =>
      Promise.resolve()
        .then(() => api.liveModels())
        .then((value) => {
          if (mounted.current && value) setModels(value);
        })
        .catch(() => {
          if (mounted.current) setError("Live models could not be read.");
        }),
    [],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unlisten = api.onLiveModelProgress((event) => {
      if (!mounted.current) return;
      setProgress(event);
      if (event.stage === "downloading") return;
      // Every other stage ends the transfer: read the list again for the new installed state.
      void refresh();
      if (event.stage !== "done") setProgress(null);
      if (event.stage === "failed")
        setError(event.error ?? "The download failed.");
    });
    return () => {
      mounted.current = false;
      void Promise.resolve(unlisten)
        .then((stop) => stop?.())
        .catch(() => undefined);
    };
  }, [refresh]);

  const save = (nextModel: string) => {
    const before = chosen;
    setChosen(nextModel);
    setError("");
    void Promise.resolve()
      .then(() => api.saveLiveSettings(nextModel))
      .then((saved) => {
        if (saved) onSaved?.(saved);
        mark();
        void refresh();
      })
      .catch((failure) => {
        setError(errorMessage(failure));
        setChosen(before);
      });
  };

  const download = () => {
    setError("");
    void Promise.resolve()
      .then(() => api.liveModelInstall(chosen))
      .then((value) => {
        if (mounted.current && value) setModels(value);
      })
      .catch((failure) => setError(errorMessage(failure)));
  };

  const cancel = () => {
    setProgress(null);
    void Promise.resolve()
      .then(() => api.liveModelCancel())
      .then((value) => {
        if (mounted.current && value) setModels(value);
      })
      .catch(() => undefined);
  };

  const selected = models?.models.find((model) => model.id === chosen) ?? null;
  const transfer = running(progress) && progress?.model_id === chosen;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;
  const canDownload =
    selected !== null &&
    selected.kind === "streaming" &&
    !selected.installed &&
    !transfer &&
    !models?.installing;
  const sameListed = models?.models.some((model) => model.id === "") ?? true;
  // Transcription in cloud mode: Same would upload live audio, so it is unavailable here.
  const sameBlocked = settings?.stt_mode === "cloud";
  const sameReason =
    models?.models.find((model) => model.id === "")?.reason ??
    SAME_CLOUD_REASON;
  // The footer does not repeat the Model line's reason.
  const helperReason = chosen === "" && sameBlocked ? sameReason : null;

  return (
    <section className="om-group" aria-label="Live transcript">
      <div className="om-group-head">
        <h3 className="om-group-label">Live transcript</h3>
        {shown && <Saved show />}
      </div>

      <div className="om-card om-rows">
        <div className="om-row">
          <div className="om-what">
            <strong>Model</strong>
            {chosen === "" ? (
              <span>
                {helperReason ??
                  "Same as Transcription uses the Speech model above."}
              </span>
            ) : (
              <span>What listens while you record</span>
            )}
          </div>
          <div className="om-side">
            <select
              className="ls-model-select"
              aria-label="Live model"
              value={chosen}
              disabled={disabled || !settings || !models}
              onChange={(event) => save(event.target.value)}
            >
              {!sameListed && (
                <option value="" disabled={sameBlocked}>
                  {SAME}
                </option>
              )}
              {(models?.models ?? []).map((model) => (
                <option
                  key={model.id}
                  value={model.id}
                  disabled={model.id === "" && sameBlocked}
                >
                  {optionLabel(model)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {canDownload && (
        <div className="om-card-foot">
          <button
            type="button"
            className="om-sm ls-download"
            onClick={download}
          >
            <IconDownload size={14} />
            Download
          </button>
          <span className="om-muted">
            {selected?.label} is not on this PC yet.
          </span>
        </div>
      )}

      {transfer && progress && (
        <div className="om-card-foot ls-job">
          <progress
            className="ls-bar"
            aria-label="Live model download progress"
            max={progress.total}
            value={progress.done}
          />
          <span className="om-muted">
            {progress.stage === "verifying"
              ? "Checking the download…"
              : `Downloading ${percent}%`}
          </span>
          <button type="button" className="om-ghost om-sm" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}

      {!models?.ready && models?.reason && models.reason !== helperReason && (
        <p className="ls-reason">{models.reason}</p>
      )}
      {error && (
        <p className="om-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
