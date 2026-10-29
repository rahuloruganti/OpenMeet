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
import {
  IconAlert,
  IconCheck,
  IconLock,
  IconSpinner,
  IconTrash,
  IconX,
} from "../../shared/ui/icons";
import { FitLabel } from "./FitLabel";
import { FIT } from "./labels";
import { ProgressJob } from "./LocalAiProgress";
import { LocalAiSearch } from "./LocalAiSearch";
import "./local-ai.css";

type Props = {
  /** The AI notes section is open. Nothing is read or listened to while it is hidden. */
  active: boolean;
  disabled: boolean;
  /** Hands the settings a saved Use returned to the page. */
  onSettings: (settings: Settings) => void;
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

/** "tiny-Q8_0.gguf · 8.00 GB · Fits your GPU" */
function optionLabel(model: LocalAiModel): string {
  return [model.name, formatBytes(model.size_bytes), FIT[model.fit]].join(
    " · ",
  );
}

const SERVER_ICON: Record<LocalAiStatus["server"], typeof IconCheck> = {
  stopped: IconX,
  starting: IconSpinner,
  running: IconCheck,
  failed: IconAlert,
};

/** One 24px status pill: semantic tint, an icon and the word. */
function ServerPill({ server }: { server: LocalAiStatus["server"] }) {
  const Glyph = SERVER_ICON[server];
  return (
    <span className={`lai-status lai-status-${server}`}>
      <Glyph size={14} />
      {SERVER[server]}
    </span>
  );
}

/** "NVIDIA GeForce RTX 4090 · 24.00 GB VRAM · 32.00 GB RAM", or "No GPU found · 32.00 GB RAM". */
function machineLabel(hardware: LocalAiStatus["hardware"]): string {
  const gpu =
    hardware.gpu_name && hardware.vram_bytes
      ? `${hardware.gpu_name} · ${formatBytes(hardware.vram_bytes)} ${
          hardware.gpu_vendor === "apple" ? "usable for models" : "VRAM"
        }`
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

/**
 * Local AI: OpenMeet's own llama.cpp server on this PC. Models are the GGUF files on this PC,
 * chosen from one dropdown. Hugging Face is searched only when asked, and nothing downloads
 * without a click. Text stays to labels of a few words; the backend holds the detail.
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

  const installEngine = () =>
    run("engine", async () => apply(await api.localAiInstallEngine()));

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

  const available = status.models.filter((model) => model.fit !== "too_big");
  const tooBig = status.models.filter(
    (model) => model.fit === "too_big",
  ).length;
  // The active model first, then whatever is left to offer.
  const preferred =
    available.find((model) => model.id === status.active_model) ?? available[0];
  const selected =
    available.find((model) => model.id === picked) ?? preferred ?? null;
  const description = selected
    ? [selected.description, selected.license].filter(Boolean).join(" · ")
    : "No model on this PC yet.";
  const engineJob = job && job.kind === "engine" ? job : null;
  const removable = selected?.removable === true;
  const inUse = status.in_use && status.active_model === selected?.id;
  const detected = serversLine(servers);
  // One sentence, and the failed server's own sentence is the one that has the fix.
  const alert =
    error || (status.server === "failed" ? (status.server_error ?? "") : "");

  return (
    <div className="lai">
      <div className="om-card">
        <div className="om-row">
          <div className="om-what">
            <strong>Your PC</strong>
            <span className="om-muted lai-machine-line">
              {machineLabel(status.hardware)}
            </span>
          </div>
          <div className="om-side">
            <span className="lai-device">
              <IconLock size={14} />
              Stays on this device
            </span>
          </div>
        </div>
        <div className="om-row">
          <div className="om-what">
            <strong>Engine</strong>
          </div>
          <div className="om-side">
            {status.engine_installed ? (
              <span className="om-muted lai-installed">
                {`Installed · ${status.engine_tag} · ${status.hardware.backend.toUpperCase()}`}
              </span>
            ) : (
              <button
                type="button"
                className="om-sm lai-download"
                aria-busy={busy === "engine"}
                disabled={disabled || busy !== null}
                onClick={installEngine}
              >
                {`Install · ${formatBytes(status.engine_download_bytes)}`}
              </button>
            )}
          </div>
        </div>
        {engineJob && (
          <div className="om-row lai-progress-row">
            <div className="om-what">
              <span className="om-muted">Engine download</span>
            </div>
            <div className="om-side">
              <ProgressJob
                job={engineJob}
                label="Engine download progress"
                cancelLabel="Cancel engine download"
                onCancel={cancel}
              />
            </div>
          </div>
        )}
        <div className="om-row">
          <div className="om-what">
            <strong>Server</strong>
          </div>
          <div className="om-side">
            <ServerPill server={status.server} />
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
        <div className="om-row lai-model-row">
          <div className="om-what">
            <strong>Model</strong>
            <span className="om-muted lai-model-help" title={description}>
              {description}
            </span>
            {selected && (
              <span
                className="om-muted lai-model-help"
                title={FIT_NOTE[selected.fit]}
              >
                {FIT_NOTE[selected.fit]}
              </span>
            )}
          </div>
          <div className="om-side lai-model-controls">
            <select
              aria-label="Local model"
              className="lai-model-select"
              value={selected?.id ?? ""}
              disabled={disabled || available.length === 0}
              onChange={(event) => setPicked(event.target.value)}
            >
              {available.length === 0 && (
                <option value="">No model on this PC yet</option>
              )}
              {available.length > 0 && (
                <optgroup label="On this PC">
                  {available.map((model) => (
                    <option key={model.id} value={model.id}>
                      {optionLabel(model)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {selected && <FitLabel fit={selected.fit} />}
            {selected &&
              (inUse ? (
                <button type="button" className="lai-inuse" disabled>
                  <IconCheck size={14} />
                  In use
                </button>
              ) : (
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
              ))}
            {removable && (
              <button
                type="button"
                className="om-ghost om-sm lai-remove"
                aria-label={`Remove ${selected.name}`}
                disabled={disabled || busy !== null}
                onClick={() => selected && removeModel(selected)}
              >
                <IconTrash size={14} />
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <LocalAiSearch
        disabled={disabled}
        busy={busy}
        job={job}
        run={run}
        apply={apply}
        onCancel={cancel}
      />

      {(tooBig > 0 || detected || alert) && (
        <div className="lai-lines">
          {tooBig > 0 && (
            <p className="lai-line">
              {tooBig === 1
                ? "1 more model is too big for this PC, so it is not listed."
                : `${tooBig} more models are too big for this PC, so they are not listed.`}
            </p>
          )}
          {detected && <p className="lai-line">{detected}</p>}
          {alert && (
            <p role="alert" className="om-error lai-line">
              {alert}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
