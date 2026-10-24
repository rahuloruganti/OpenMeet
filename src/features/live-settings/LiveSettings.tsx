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
import { Saved, useSaved } from "../../shared/ui/settings-link";
import "./live-settings.css";

type Props = {
  settings: Settings | null;
  disabled: boolean;
};

const SAME = "Same as Transcription";

/** "(download 55 MB)" for a pinned model that is not on this PC yet. */
const optionLabel = (model: LiveModel) =>
  model.installed || model.download_bytes === null
    ? model.label
    : `${model.label} (download ${formatBytes(model.download_bytes)})`;

const running = (progress: LiveModelProgress | null) =>
  progress !== null &&
  (progress.stage === "downloading" || progress.stage === "verifying");

/**
 * Settings > Recording > Live transcript: the switch, the engine to run, and the one explicit
 * download of a pinned streaming model. Nothing is fetched until this group opens, and nothing is
 * downloaded until Download is clicked.
 */
export function LiveSettings({ settings, disabled }: Props) {
  const [models, setModels] = useState<LiveModels | null>(null);
  const [progress, setProgress] = useState<LiveModelProgress | null>(null);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(settings?.live_transcript ?? true);
  const [chosen, setChosen] = useState(settings?.live_model ?? "");
  const { shown, mark } = useSaved();
  const mounted = useRef(true);

  // Settings can arrive after the first render, and other panels can change them.
  useEffect(() => {
    setEnabled(settings?.live_transcript ?? true);
    setChosen(settings?.live_model ?? "");
  }, [settings?.live_transcript, settings?.live_model]);

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

  const save = (nextEnabled: boolean, nextModel: string) => {
    const before = { enabled, chosen };
    setEnabled(nextEnabled);
    setChosen(nextModel);
    setError("");
    void Promise.resolve()
      .then(() => api.saveLiveSettings(nextEnabled, nextModel))
      .then(() => {
        mark();
        void refresh();
      })
      .catch((failure) => {
        setError(errorMessage(failure));
        setEnabled(before.enabled);
        setChosen(before.chosen);
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

  return (
    <section className="om-group" aria-label="Live transcript">
      <h3 className="om-group-label">
        Live transcript
        {shown && <Saved show />}
      </h3>

      <div className="om-card om-rows">
        <div className="om-row">
          <div className="om-what">
            <strong>Show text while recording</strong>
            <span>Text appears as you speak.</span>
          </div>
          <div className="om-side">
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Show text while recording"
              className="om-switch"
              disabled={disabled || !settings}
              onClick={() => save(!enabled, chosen)}
            />
          </div>
        </div>

        <div className="om-row">
          <div className="om-what">
            <strong>Model</strong>
            {chosen === "" ? (
              <span>Same as Transcription uses the Speech model above.</span>
            ) : selected?.leaves_device ? (
              <span className="om-leaves">Leaves this device</span>
            ) : (
              <span>What listens while you record</span>
            )}
          </div>
          <div className="om-side">
            <select
              aria-label="Live model"
              value={chosen}
              disabled={disabled || !settings || !models}
              onChange={(event) => save(enabled, event.target.value)}
            >
              {!sameListed && <option value="">{SAME}</option>}
              {(models?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {optionLabel(model)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {canDownload && (
        <div className="om-card-foot">
          <button type="button" className="om-sm" onClick={download}>
            Download
          </button>
          <span className="om-muted">
            {selected?.label} is not on this PC yet.
          </span>
        </div>
      )}

      {transfer && progress && (
        <div className="om-card-foot">
          <progress max={progress.total} value={progress.done} />
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

      {!models?.ready && models?.reason && (
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
