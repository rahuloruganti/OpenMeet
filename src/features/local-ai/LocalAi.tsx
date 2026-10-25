import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type LocalAiFit,
  type LocalAiJob,
  type LocalAiModel,
  type LocalAiStatus,
  type LocalServer,
  type Settings,
} from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";
import "./local-ai.css";

type Props = {
  /** The AI notes section is open. Nothing is read or listened to while it is hidden. */
  active: boolean;
  disabled: boolean;
  /** Hands the settings a saved Use or Set up for me returned to the page. */
  onSettings: (settings: Settings) => void;
};

/** The fit as three words, matching the estimate the backend makes. */
const FIT: Record<LocalAiFit, string> = {
  gpu: "Fits your GPU",
  ram: "Uses system RAM",
  too_big: "Too big",
};

/** What the fit label means for the person choosing, in one plain sentence. */
const FIT_NOTE: Record<LocalAiFit, string> = {
  gpu: "Fits your graphics card, so it runs fastest on this PC.",
  ram: "Runs from system memory, which is slower than a graphics card.",
  too_big: "Needs more memory than this PC has.",
};

const SERVER: Record<LocalAiStatus["server"], string> = {
  stopped: "Off",
  starting: "Starting",
  running: "On",
  failed: "Failed",
};

/** "Qwen3 14B · 9.00 GB · Fits your GPU · Recommended · Downloaded" */
function optionLabel(model: LocalAiModel): string {
  return [
    model.name,
    formatBytes(model.size_bytes),
    FIT[model.fit],
    model.recommended ? "Recommended" : "",
    model.downloaded && model.source === "catalog" ? "Downloaded" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "NVIDIA GeForce RTX 4090 · 24.00 GB VRAM · 32.00 GB RAM", or "No GPU found · 32.00 GB RAM". */
function machineLabel(hardware: LocalAiStatus["hardware"]): string {
  const gpu =
    hardware.gpu_name && hardware.vram_bytes
      ? `${hardware.gpu_name} · ${formatBytes(hardware.vram_bytes)} VRAM`
      : "No GPU found";
  return `${gpu} · ${formatBytes(hardware.ram_bytes)} RAM`;
}

/** One muted line for the chat servers already running here, or "" when there are none. */
function serversLine(servers: LocalServer[]): string {
  const chat = servers.filter(
    (server) => server.kind === "chat" || server.kind === "both",
  );
  const names = chat.map((server) => server.name);
  if (names.length === 0) return "";
  if (names.length === 1)
    return `${names[0]} is running · use it with New connection above`;
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} are running · use them with New connection above`;
}

/** A download in flight: how far it is, and the way to stop it. */
function Job(props: {
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

/**
 * Local AI: OpenMeet's own llama.cpp server on this PC. Models are chosen from one dropdown,
 * downloaded only on an explicit click, and never sent anywhere. Text stays to labels of a
 * few words; the backend holds the detail.
 */
export function LocalAi({ active, disabled, onSettings }: Props) {
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  const [servers, setServers] = useState<LocalServer[]>([]);
  const [job, setJob] = useState<LocalAiJob | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Progress arrives while a download or setup runs; subscribe only while the section is open.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const unlisten = api.onLocalAiProgress((value) => {
      if (alive) setJob(value);
    });
    void unlisten
      ?.then((stop) => {
        if (!alive) stop();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      void unlisten?.then((stop) => stop()).catch(() => undefined);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    // Promise.resolve: a stubbed api may answer with nothing.
    void Promise.resolve()
      .then(() => api.localAiStatus())
      .then((value) => {
        if (!alive || !value) return;
        setStatus(value);
        setJob(value.job ?? null);
      })
      .catch((failure) => {
        if (alive) setError(errorMessage(failure));
      });
    void Promise.resolve()
      .then(() => api.detectLocalServers())
      .then((value) => {
        if (alive) setServers(value ?? []);
      })
      .catch(() => {
        /* Other servers are a hint, never an error. */
      });
    return () => {
      alive = false;
    };
  }, [active]);

  const apply = (next: LocalAiStatus | null | undefined) => {
    if (live.current && next) setStatus(next);
  };

  /** Reads the status again, so the rows show what the backend just saved. */
  const refresh = async () => {
    try {
      apply(await api.localAiStatus());
    } catch {
      /* The action already reported its own failure. */
    }
  };

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      if (live.current) {
        setBusy(null);
        setJob(null);
      }
    }
  };

  const cancel = () => {
    void api.localAiCancel().then(
      () => {
        if (live.current) setJob(null);
      },
      (failure) => {
        if (live.current) setError(errorMessage(failure));
      },
    );
  };

  const quickstart = () =>
    run("quickstart", async () => {
      onSettings(await api.localAiQuickstart());
      await refresh();
    });

  const installEngine = () =>
    run("engine", async () => apply(await api.localAiInstallEngine()));

  const downloadModel = (model: LocalAiModel) =>
    run(`model:${model.id}`, async () =>
      apply(await api.localAiDownloadModel(model.id)),
    );

  const useModel = (model: LocalAiModel) =>
    run("use", async () => {
      onSettings(await api.localAiUse(model.id));
      await refresh();
    });

  const removeModel = (model: LocalAiModel) =>
    run("remove", async () => apply(await api.localAiRemoveModel(model.id)));

  const startServer = () =>
    run("server", async () => apply(await api.localAiStart()));

  const stopServer = () =>
    run("server", async () => apply(await api.localAiStop()));

  if (!active) return null;

  if (!status) {
    return (
      <>
        {error ? (
          <p role="alert" className="om-error">
            {error}
          </p>
        ) : (
          <p className="om-empty">Reading this PC…</p>
        )}
      </>
    );
  }

  const catalog = status.models.filter(
    (model) => model.source === "catalog" && model.fit !== "too_big",
  );
  const files = status.models.filter(
    (model) => model.source === "file" && model.fit !== "too_big",
  );
  const available = [...catalog, ...files];
  const tooBig = status.models.filter(
    (model) => model.fit === "too_big",
  ).length;
  // The active model first, then the recommended one, then whatever is left to offer.
  const preferred =
    available.find((model) => model.id === status.active_model) ??
    available.find((model) => model.recommended) ??
    available[0];
  const selected =
    available.find((model) => model.id === picked) ?? preferred ?? null;
  // Nothing downloaded yet and no engine: the one-click setup earns its place.
  const unsetUp =
    !status.engine_installed &&
    !status.models.some(
      (model) => model.source === "catalog" && model.downloaded,
    );
  const downloadJob =
    job && job.kind === "model" && job.target === selected?.id ? job : null;
  const setupJob =
    job && (job.kind === "quickstart" || busy === "quickstart") ? job : null;
  const engineJob = job && job.kind === "engine" ? job : null;
  const removable = selected?.source === "catalog" && selected.downloaded;
  const inUse = status.in_use && status.active_model === selected?.id;
  const detected = serversLine(servers);
  // One sentence, and the failed server's own sentence is the one that has the fix.
  const alert =
    error || (status.server === "failed" ? (status.server_error ?? "") : "");

  return (
    <>
      <div className="om-card lai-machine">
        <span className="lai-what">
          <strong>Your PC</strong>
          <span className="om-muted">{machineLabel(status.hardware)}</span>
        </span>
        <span className="om-tag">Stays on this device</span>
      </div>

      {unsetUp && (
        <div className="om-card lai-start">
          <span className="lai-what">
            <strong>Not set up yet</strong>
            <span className="om-muted">
              OpenMeet downloads the engine and the best model for this PC, then
              uses it. Nothing downloads until you click.
            </span>
          </span>
          {setupJob ? (
            <Job
              job={setupJob}
              label="Setup progress"
              cancelLabel="Cancel setup"
              onCancel={cancel}
            />
          ) : (
            <button
              type="button"
              className="om-sm lai-primary"
              aria-busy={busy === "quickstart"}
              disabled={disabled || busy !== null}
              onClick={quickstart}
            >
              Set up for me
            </button>
          )}
        </div>
      )}

      <div className="om-card lai-rows">
        <div className="om-row">
          <div className="om-what">
            <strong>Engine</strong>
          </div>
          <div className="om-side">
            {status.engine_installed ? (
              <span className="om-muted">
                {`Installed · ${status.engine_tag} · ${status.hardware.backend.toUpperCase()}`}
              </span>
            ) : (
              <button
                type="button"
                className="om-sm"
                aria-busy={busy === "engine"}
                disabled={disabled || busy !== null}
                onClick={installEngine}
              >
                {`Install · ${formatBytes(status.engine_download_bytes)}`}
              </button>
            )}
          </div>
        </div>
        <div className="om-row">
          <div className="om-what">
            <strong>Server</strong>
          </div>
          <div className="om-side">
            <span className={`om-tag lai-pill lai-pill-${status.server}`}>
              {SERVER[status.server]}
            </span>
            <button
              type="button"
              className="om-sm"
              aria-busy={busy === "server"}
              disabled={
                disabled || busy !== null || status.server === "starting"
              }
              onClick={status.server === "running" ? stopServer : startServer}
            >
              {status.server === "running" ? "Turn off" : "Turn on"}
            </button>
          </div>
        </div>
        {engineJob && (
          <div className="lai-inline">
            <Job
              job={engineJob}
              label="Engine download progress"
              cancelLabel="Cancel engine download"
              onCancel={cancel}
            />
          </div>
        )}
      </div>

      <div className="om-card lai-model">
        <div className="om-row">
          <div className="om-what">
            <strong>Model</strong>
          </div>
          <div className="om-side">
            <select
              aria-label="Local model"
              value={selected?.id ?? ""}
              disabled={disabled || available.length === 0}
              onChange={(event) => setPicked(event.target.value)}
            >
              {available.length === 0 && (
                <option value="">No model fits this PC</option>
              )}
              {catalog.length > 0 && (
                <optgroup label="Catalog">
                  {catalog.map((model) => (
                    <option key={model.id} value={model.id}>
                      {optionLabel(model)}
                    </option>
                  ))}
                </optgroup>
              )}
              {files.length > 0 && (
                <optgroup label="On this PC">
                  {files.map((model) => (
                    <option key={model.id} value={model.id}>
                      {optionLabel(model)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {selected && <span className="om-tag">{FIT[selected.fit]}</span>}
            {selected &&
              (downloadJob ? (
                <Job
                  job={downloadJob}
                  label="Download progress"
                  cancelLabel="Cancel download"
                  onCancel={cancel}
                />
              ) : inUse ? (
                <button type="button" className="om-sm" disabled>
                  In use
                </button>
              ) : selected.downloaded || selected.source === "file" ? (
                <button
                  type="button"
                  className="om-sm"
                  aria-label={`Use ${selected.name}`}
                  aria-busy={busy === "use"}
                  disabled={disabled || busy !== null}
                  onClick={() => useModel(selected)}
                >
                  Use
                </button>
              ) : (
                <button
                  type="button"
                  className="om-sm"
                  aria-label={`Download ${selected.name}`}
                  aria-busy={busy === `model:${selected.id}`}
                  disabled={disabled || busy !== null}
                  onClick={() => downloadModel(selected)}
                >
                  {`Download · ${formatBytes(selected.size_bytes)}`}
                </button>
              ))}
            {removable && !downloadJob && (
              <button
                type="button"
                className="om-ghost om-sm"
                aria-label={`Remove ${selected.name}`}
                disabled={disabled || busy !== null}
                onClick={() => selected && removeModel(selected)}
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <p className="lai-note">
          {selected
            ? [selected.description, selected.license]
                .filter(Boolean)
                .join(" · ")
            : "No model fits this PC."}
        </p>
        {selected && <p className="lai-note">{FIT_NOTE[selected.fit]}</p>}
      </div>

      {tooBig > 0 && (
        <p className="lai-line">
          {tooBig === 1
            ? "1 more model is too big for this PC, so it is not listed."
            : `${tooBig} more models are too big for this PC, so they are not listed.`}
        </p>
      )}
      {detected && <p className="lai-line">{detected}</p>}
      {alert && (
        <p role="alert" className="om-error">
          {alert}
        </p>
      )}
    </>
  );
}
