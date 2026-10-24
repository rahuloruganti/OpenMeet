import { useState, type ReactNode } from "react";
import type {
  Settings,
  SttDownloadProgress,
  SttStatus,
} from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";
import { speechModelLabel } from "../../shared/lib/models";
import { Tip } from "../../shared/ui/info-tip";
import { Saved, useSaved } from "../../shared/ui/settings-link";

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

type Props = {
  settings: Settings | null;
  disabled: boolean;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  /** The model library panel, mounted only while "Get models" is open. */
  library?: ReactNode;
  /** The cloud speech connection card, shown only when the engine is Cloud. */
  cloudForm?: ReactNode;
  onMode: (mode: Settings["stt_mode"]) => void;
  onInstall: () => void;
  onCancel: () => void;
  /** Saves language, vocabulary hint or model immediately. */
  onSave: (draft: SttDraft) => void;
};

/** Engine choice, its options, the installed models, and the cloud speech connection. */
export function TranscriptionSettings(props: Props) {
  const { settings, disabled, stt } = props;
  const { shown, mark } = useSaved();
  // Typed text lives here until it is saved on blur; everything else saves at once.
  const [prompt, setPrompt] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
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
  const canInstall = !!stt?.supported && !stt.installed;
  return (
    <div className="om-pane">
      <h2>Transcription</h2>

      <section className="om-group" aria-label="Engine">
        <span className="om-group-label">Engine</span>
        <div className="om-card om-rows">
          <div className="om-row">
            <div className="om-what">
              <strong>Runs</strong>
            </div>
            <div className="om-side">
              <div className="om-seg" role="group" aria-label="Runs">
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
                    {option.id === "cloud" ? (
                      <span className="om-leaves">Leaves this device</span>
                    ) : (
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
          <span className="om-group-label">
            Connection
            <span className="om-leaves">Leaves this device</span>
            <Tip
              label="Connection"
              text="Recorded audio is uploaded to your speech connection when you transcribe. Nothing else leaves this device."
            />
          </span>
          {props.cloudForm ?? (
            <p className="om-empty">Add a speech connection first.</p>
          )}
        </section>
      ) : (
        <>
          <section className="om-group" aria-label="Options">
            <span className="om-group-label">Options</span>
            <div className="om-card om-rows">
              <div className="om-row">
                <div className="om-what">
                  <strong>Language</strong>
                </div>
                <div className="om-side">
                  <select
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
              <div className="om-row">
                <div className="om-what">
                  <strong>Install</strong>
                </div>
                <div className="om-side">
                  <span className="om-muted">
                    {!stt
                      ? "Status unavailable"
                      : !stt.supported
                        ? "Not supported on this platform yet"
                        : stt.installed
                          ? "Installed and verified"
                          : "Not installed"}
                  </span>
                  {canInstall && (
                    <button
                      type="button"
                      className="om-sm"
                      disabled={disabled || props.installing}
                      title={`≈ ${formatBytes(stt?.missing_bytes ?? 0)}`}
                      onClick={props.onInstall}
                    >
                      Download models
                    </button>
                  )}
                  {props.installing && (
                    <button
                      type="button"
                      className="om-ghost om-sm"
                      onClick={props.onCancel}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              {props.sttProgress && (
                <div className="om-row">
                  <div className="om-what">
                    <strong>Downloading</strong>
                  </div>
                  <div className="om-side">
                    <span className="om-muted">
                      {formatBytes(props.sttProgress.downloaded)} /{" "}
                      {formatBytes(props.sttProgress.total)}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <details className="om-more">
              <summary>More options</summary>
              <div className="om-more-body">
                <div className="om-frow">
                  <span>Vocabulary hint</span>
                  <Tip
                    label="Vocabulary hint"
                    text="Names and jargon the engine should expect, up to 500 characters. Sent with the audio when you use cloud speech."
                  />
                </div>
                <input
                  aria-label="Vocabulary hint"
                  value={prompt ?? settings?.stt_prompt ?? ""}
                  maxLength={500}
                  disabled={disabled || !settings}
                  placeholder="e.g. Priya, Okta, Kubernetes"
                  onChange={(event) => setPrompt(event.target.value)}
                  onBlur={() => {
                    if (prompt === null) return;
                    save({ stt_prompt: prompt });
                    setPrompt(null);
                  }}
                />
              </div>
            </details>
          </section>

          <section className="om-group" aria-label="Models">
            <span className="om-group-label">
              Models
              <Tip
                label="Models"
                text="Whisper ggml files and sherpa-onnx folders only. Every download is checked against pinned SHA-256 checksums."
              />
            </span>
            <div className="om-card om-rows">
              {installed.length === 0 && current === "" && (
                <div className="om-row">
                  <div className="om-what">
                    <strong>No models yet</strong>
                    <span>Open Get models to add one</span>
                  </div>
                </div>
              )}
              {installed.map((model) => (
                <div className="om-row" key={model.id}>
                  <div className="om-what">
                    <strong>{speechModelLabel(model.id)}</strong>
                    <span className="om-mono">{formatBytes(model.size)}</span>
                  </div>
                  <div className="om-side">
                    {model.id === current ? (
                      <span className="om-tag">In use</span>
                    ) : (
                      <button
                        type="button"
                        className="om-ghost om-sm"
                        aria-label={`Use ${speechModelLabel(model.id)}`}
                        disabled={disabled}
                        onClick={() => save({ stt_model: model.id })}
                      >
                        Use
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {current !== "" && !installedIds.includes(current) && (
                <div className="om-row">
                  <div className="om-what">
                    <strong>{speechModelLabel(current)}</strong>
                    <span className="om-mono">Not downloaded</span>
                  </div>
                  <div className="om-side">
                    <span className="om-tag">In use</span>
                  </div>
                </div>
              )}
            </div>
            <div className="om-card-foot">
              <button
                type="button"
                className="om-ghost om-sm"
                aria-expanded={modelsOpen}
                disabled={disabled}
                onClick={() => setModelsOpen((open) => !open)}
              >
                Get models
              </button>
              <span className="om-spacer" />
              <span className="om-muted">{formatBytes(onDisk)} on disk</span>
            </div>
            {modelsOpen && (
              <div className="om-card om-library">{props.library}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
