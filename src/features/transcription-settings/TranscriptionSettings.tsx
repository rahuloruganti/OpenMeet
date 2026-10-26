import { useState, type ReactNode } from "react";
import type {
  LocalModel,
  Settings,
  SttDownloadProgress,
  SttStatus,
} from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";
import {
  recommendedSpeechModels,
  speechModelFits,
  speechModelLabel,
} from "../../shared/lib/models";
import { IconAlert, IconCheck, IconDownload } from "../../shared/ui/icons";
import { Saved, useSaved } from "../../shared/ui/settings-link";
import "./transcription-settings.css";

/** The three fields one transcription save writes. */
export type SttDraft = Pick<
  Settings,
  "stt_language" | "stt_prompt" | "stt_model"
>;

const languageName = (code: string) => {
  if (code === "auto") return "Detect automatically";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Shown as visible text beside a disabled control, so the reason never needs a tooltip. */
const BUSY_REASON = "Wait for the current task to finish.";

type Props = {
  settings: Settings | null;
  disabled: boolean;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  /** The own-model panel, mounted only while "Add your own model" is open. */
  library?: ReactNode;
  /** The cloud speech connection card, shown only when the engine is Cloud. */
  cloudForm?: ReactNode;
  /** Model files a local, read-only folder scan found on this PC. Only Whisper files are
   * usable in place; the rest are not offered. */
  localFiles?: LocalModel[];
  onMode: (mode: Settings["stt_mode"]) => void;
  onInstall: () => void;
  onCancel: () => void;
  /** Chooses a catalog model and downloads it (save, then install). */
  onDownload?: (draft: SttDraft) => void;
  /** Saves language, vocabulary hint or model immediately. */
  onSave: (draft: SttDraft) => void;
};

/** Engine choice, its options, the installed models, and the cloud speech connection. */
export function TranscriptionSettings(props: Props) {
  const { settings, disabled, stt } = props;
  const { shown, mark } = useSaved();
  // Typed text lives here until it is saved on blur; everything else saves at once.
  const [prompt, setPrompt] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const cloud = settings?.stt_mode === "cloud";
  const current = settings?.stt_model ?? "";
  const draft = (change: Partial<SttDraft>): SttDraft => ({
    stt_language: settings?.stt_language ?? "auto",
    stt_prompt: settings?.stt_prompt ?? "",
    stt_model: current,
    ...change,
  });
  const save = (change: Partial<SttDraft>) => {
    props.onSave(draft(change));
    mark();
  };
  const installed = (stt?.models ?? []).filter((model) => model.installed);
  const installedIds = installed.map((model) => model.id);
  const onDisk = installed.reduce((total, model) => total + model.size, 0);
  const language = settings?.stt_language ?? "auto";
  // The model menu lists only what is on this PC, can run here and fits the spoken language.
  const ready = installed.filter((model) => !model.reason);
  const files = (props.localFiles ?? []).filter(
    (file) =>
      file.format === "whisper" &&
      !(file.model_id && installedIds.includes(file.model_id)),
  );
  const choices = [
    ...ready.map((model) => ({ id: model.id, size: model.size })),
    ...files.map((file) => ({ id: file.path, size: file.size })),
  ].filter((choice) => speechModelFits(choice.id, language));
  const blocked = installed.some(
    (model) => model.id === current && model.reason,
  );
  // A Whisper file used in place outside the scanned folders: the status check found it.
  if (
    current !== "" &&
    !choices.some((choice) => choice.id === current) &&
    !blocked &&
    !!stt?.model &&
    speechModelFits(current, language)
  )
    choices.push({ id: current, size: 0 });
  const currentListed = choices.some((choice) => choice.id === current);
  // Catalog models not yet on this PC that can run here and fit the spoken language.
  const catalog = (stt?.models ?? []).filter(
    (model) =>
      !model.installed && !model.reason && speechModelFits(model.id, language),
  );
  const supported = !!stt?.supported;
  // The single model the row offers to download: the chosen catalog model when that is what
  // is selected, otherwise the recommended catalog model for the spoken language.
  const recommended =
    recommendedSpeechModels(language)
      .map((id) => catalog.find((model) => model.id === id))
      .find((model) => model !== undefined) ?? catalog[0];
  const chosenCatalog = catalog.find((model) => model.id === current);
  const target = currentListed ? null : (chosenCatalog ?? recommended ?? null);
  // A model on disk whose VAD file is still missing is completed by Install.
  const isReady = currentListed && !!stt?.installed;
  const downloadId = currentListed ? current : (target?.id ?? null);
  const downloadSize = currentListed
    ? (stt?.missing_bytes ?? 0)
    : (target?.size ?? 0);
  const showDownload =
    supported &&
    !isReady &&
    !props.installing &&
    downloadId !== null &&
    (downloadId === current || !!props.onDownload);
  const others = supported
    ? catalog.filter((model) => model.id !== downloadId)
    : [];
  const busy = disabled || !settings;
  const currentProblem =
    current === "" || currentListed
      ? null
      : !speechModelFits(current, language)
        ? "Doesn't fit the spoken language. Pick another."
        : blocked
          ? "Can't run on this PC. Pick another."
          : downloadId === current
            ? null
            : "Not available on this PC. Pick another or download one.";
  const percent =
    props.sttProgress && props.sttProgress.total > 0
      ? Math.min(
          100,
          Math.round(
            (props.sttProgress.downloaded / props.sttProgress.total) * 100,
          ),
        )
      : null;
  const shownId = currentListed ? current : (downloadId ?? (current || null));
  const status = props.installing
    ? percent === null
      ? "Downloading…"
      : `Downloading ${percent}%`
    : !stt
      ? "Status unavailable"
      : !stt.supported
        ? "Not available here"
        : isReady
          ? "Ready"
          : downloadId !== null
            ? downloadSize > 0
              ? `Not downloaded · ${formatBytes(downloadSize)}`
              : "Not downloaded"
            : "No model for this language yet";
  const engineLine = !stt
    ? "Status unavailable"
    : !stt.supported
      ? "Not supported on this platform yet"
      : !stt.engine
        ? "Missing. Reinstall OpenMeet."
        : "Available";
  const statusTone = props.installing
    ? "busy"
    : !stt
      ? "idle"
      : !stt.supported
        ? "warn"
        : isReady
          ? "ok"
          : "idle";
  const StatusIcon = props.installing
    ? IconDownload
    : !stt
      ? IconAlert
      : !stt.supported
        ? IconAlert
        : isReady
          ? IconCheck
          : IconDownload;
  const engineTone = !stt
    ? "idle"
    : !stt.supported
      ? "warn"
      : !stt.engine
        ? "error"
        : "ok";
  const EngineIcon = engineTone === "ok" ? IconCheck : IconAlert;
  return (
    <div className="om-pane">
      <h2>Transcription</h2>

      <section className="om-group" aria-label="Process audio">
        <h3 className="om-group-label">Process audio</h3>
        <div className="om-card om-rows">
          <div className="om-row">
            <div className="om-what">
              <span className="om-muted">Where speech becomes text.</span>
            </div>
            <div className="om-side">
              <div className="om-seg" role="group" aria-label="Process audio">
                {(
                  [
                    {
                      id: "local",
                      title: "On this PC",
                      note: "Audio stays here",
                    },
                    { id: "cloud", title: "Cloud" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={(cloud ? "cloud" : "local") === option.id}
                    disabled={disabled || !settings}
                    onClick={() => props.onMode(option.id)}
                  >
                    <span className="om-seg-t">{option.title}</span>
                    {option.id !== "cloud" && (
                      <span className="om-seg-s">{option.note}</span>
                    )}
                  </button>
                ))}
              </div>
              <Saved show={shown} />
            </div>
          </div>
        </div>
      </section>

      {cloud ? (
        <section className="om-group" aria-label="Connection">
          <h3 className="om-group-label">Connection</h3>
          {props.cloudForm ?? (
            <p className="om-empty">Add a speech connection first.</p>
          )}
        </section>
      ) : (
        <>
          <section className="om-group" aria-label="Options">
            <h3 className="om-group-label">Options</h3>
            <div className="om-card om-rows">
              <div className="om-row">
                <div className="om-what">
                  <strong>Language</strong>
                </div>
                <div className="om-side">
                  <select
                    className="stt-language"
                    aria-label="Spoken language"
                    value={settings?.stt_language ?? "auto"}
                    disabled={disabled || !settings}
                    onChange={(event) =>
                      save({ stt_language: event.target.value })
                    }
                  >
                    {(stt?.languages ?? [settings?.stt_language ?? "auto"]).map(
                      (code) => (
                        <option key={code} value={code}>
                          {languageName(code)}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              </div>
            </div>
          </section>

          <section className="om-group" aria-label="Models">
            <h3 className="om-group-label">Models</h3>
            <div className="om-card om-rows">
              <div className="om-row">
                <div className="om-what">
                  <strong>Speech model</strong>
                  <span
                    className={`stt-status stt-status-${statusTone}`}
                    aria-live="polite"
                  >
                    <StatusIcon size={14} />
                    <span>{status}</span>
                  </span>
                  {showDownload && busy && (
                    <span className="om-muted">{BUSY_REASON}</span>
                  )}
                  {currentProblem && (
                    <span role="alert" className="om-error">
                      {currentProblem}
                    </span>
                  )}
                </div>
                <div className="om-side">
                  {choices.length > 0 ? (
                    <select
                      className="stt-model-select"
                      aria-label="Speech model"
                      value={current}
                      disabled={busy}
                      onChange={(event) =>
                        save({ stt_model: event.target.value })
                      }
                    >
                      {current === "" && (
                        <option value="" disabled>
                          Choose a model
                        </option>
                      )}
                      {current !== "" && !currentListed && (
                        <option value={current} disabled>
                          {speechModelLabel(current)}
                        </option>
                      )}
                      {choices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {speechModelLabel(choice.id)}
                          {choice.size > 0
                            ? ` · ${formatBytes(choice.size)}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>
                      {shownId ? speechModelLabel(shownId) : "No model yet"}
                    </span>
                  )}
                  {props.installing ? (
                    <span className="stt-job">
                      <progress
                        className="stt-bar"
                        aria-label="Speech model download progress"
                        max={props.sttProgress?.total || 100}
                        value={props.sttProgress?.downloaded ?? 0}
                      />
                      <button
                        type="button"
                        className="om-ghost om-sm"
                        onClick={props.onCancel}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    showDownload && (
                      <button
                        type="button"
                        className="om-sm"
                        disabled={busy}
                        onClick={() => {
                          if (downloadId === current) {
                            props.onInstall();
                            return;
                          }
                          props.onDownload?.(
                            draft({ stt_model: downloadId ?? current }),
                          );
                          mark();
                        }}
                      >
                        Download
                      </button>
                    )
                  )}
                </div>
              </div>
              <div className="om-row">
                <div className="om-what">
                  <strong>Engine</strong>
                </div>
                <div className="om-side">
                  <span className={`stt-status stt-status-${engineTone}`}>
                    <EngineIcon size={14} />
                    <span>{engineLine}</span>
                  </span>
                </div>
              </div>
            </div>
            {props.onDownload && others.length > 0 && (
              <details className="om-more">
                <summary>Other models</summary>
                <div className="om-more-body">
                  {busy || props.installing ? (
                    <p className="om-muted">{BUSY_REASON}</p>
                  ) : null}
                  {others.map((model) => {
                    const name = speechModelLabel(model.id);
                    return (
                      <div className="om-row" key={model.id}>
                        <div className="om-what">
                          <strong>{name}</strong>
                          <span className="stt-size">
                            {formatBytes(model.size)}
                          </span>
                        </div>
                        <div className="om-side">
                          <button
                            type="button"
                            className="om-sm"
                            aria-label={`Download ${name}`}
                            disabled={busy || props.installing}
                            onClick={() => {
                              props.onDownload?.(
                                draft({ stt_model: model.id }),
                              );
                              mark();
                            }}
                          >
                            Download
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
            <div className="om-card-foot">
              <span className="om-spacer" />
              <span className="om-muted stt-on-disk">
                {formatBytes(onDisk)} on disk
              </span>
            </div>
            <details className="om-more">
              <summary>More options</summary>
              <div className="om-more-body">
                <div className="om-frow">
                  <span>Vocabulary hint</span>
                </div>
                <input
                  aria-label="Vocabulary hint"
                  value={prompt ?? settings?.stt_prompt ?? ""}
                  maxLength={500}
                  disabled={busy}
                  placeholder="e.g. Priya, Okta, Kubernetes"
                  onChange={(event) => setPrompt(event.target.value)}
                  onBlur={() => {
                    if (prompt === null) return;
                    save({ stt_prompt: prompt });
                    setPrompt(null);
                  }}
                />
                <div className="om-frow">
                  <button
                    type="button"
                    className="om-ghost om-sm"
                    aria-expanded={addOpen}
                    disabled={disabled}
                    onClick={() => setAddOpen((open) => !open)}
                  >
                    Add your own model
                  </button>
                  {disabled && <span className="om-muted">{BUSY_REASON}</span>}
                </div>
                {addOpen && (
                  <div className="om-card om-library">{props.library}</div>
                )}
              </div>
            </details>
          </section>
        </>
      )}
    </div>
  );
}
