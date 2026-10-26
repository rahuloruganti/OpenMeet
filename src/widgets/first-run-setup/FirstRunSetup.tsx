import { useEffect, useRef, useState, type Ref } from "react";
import {
  api,
  type AudioDevices,
  type ImportStatus,
  type KeyStatus,
  type LocalModel,
  type LocalServer,
  type ProviderModel,
  type ProviderRole,
  type Settings,
  type SttDownloadProgress,
  type SttStatus,
} from "../../shared/api/api";
import { displayPath, formatBytes } from "../../entities/meeting";
import {
  modelsFor,
  recommendedSpeechModels,
  speechModelLabel,
} from "../../shared/lib/models";
import { useTask } from "../../shared/lib/use-task";
import {
  CUSTOM_PROVIDER,
  freeName,
  presetById,
  presetsFor,
} from "../../shared/lib/providers";
import { BrandMark } from "../../shared/ui/brand-mark";
import {
  baseUrlError,
  hostOf,
  publishSettings,
} from "../../features/provider-settings";
import "./first-run.css";

/** The wizard's steps, in order; Import appears only when there is something to bring over. */
type Step = "import" | "transcription" | "ai" | "devices" | "done";

const baseSteps: Step[] = ["transcription", "ai", "devices", "done"];

const stepLabels: Record<Step, string> = {
  import: "Import",
  transcription: "Transcription",
  ai: "AI notes",
  devices: "Devices",
  done: "Done",
};

type Props = {
  panelRef?: Ref<HTMLElement>;
  settings: Settings;
  devices: AudioDevices | null;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  onInstallStt: () => void;
  onRefreshDevices: () => void;
  onSettings: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
  /** The defaults chosen here become New recording's selection. */
  onDevices: (microphone: string, output: string) => void;
  /** Called after setup is saved; the shell may then hand focus to the workspace. */
  onSkipSetup?: () => void;
  onStartMeeting: () => void;
  onOpenSettings: () => void;
};

/** Connects a server or API, then picks a model for one task. Keys go straight to the OS
 * keychain through the backend; the field is uncontrolled and cleared after use. */
function ConnectAndPick(props: {
  role: ProviderRole;
  settings: Settings;
  /** A detected local server; null lets the user type any OpenAI-compatible API. */
  server: LocalServer | null;
  onSettings: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
}) {
  const { role, settings, server } = props;
  // A detected server keeps its own name and URL; otherwise the user picks a provider.
  const presets = presetsFor(role);
  const [provider, setProvider] = useState(
    server ? CUSTOM_PROVIDER : (presets[0]?.id ?? CUSTOM_PROVIDER),
  );
  const [name, setName] = useState(server?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(server?.base_url ?? "");
  const key = useRef<HTMLInputElement>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderModel[]>(
    server && !server.needs_key ? server.models : [],
  );
  const [all, setAll] = useState(false);
  const [model, setModel] = useState("");
  const { busy, error, notice, setNotice, run } = useTask();
  const publish = (next: Settings) =>
    publishSettings(next, {
      onSaved: props.onSettings,
      onKeyStatus: props.onKeyStatus,
    });
  const shown = modelsFor(models, role, all);
  const assigned = settings.provider_assignments[role];
  // A preset fills the URL and the name; "Custom" keeps the free-form fields.
  const preset = server ? null : presetById(provider);
  const url = preset ? preset.baseUrl : baseUrl.trim();
  // Blank name on a custom API saves as its destination, so nothing blocks the connect.
  const connectionName = preset
    ? freeName(
        preset.label,
        settings.saved_connections.map((item) => item.name),
      )
    : name.trim() || hostOf(url);
  // The same rule Settings applies, so a URL rejected there is rejected here too.
  const urlError = server || preset ? null : baseUrlError(baseUrl);

  const connect = () =>
    run(async () => {
      const typed = key.current?.value ?? "";
      if (key.current) key.current.value = "";
      const existing = settings.saved_connections.find(
        (item) => item.base_url === url,
      );
      let current = settings;
      if (!existing || typed) {
        current = await api.saveApiConnection({
          id: existing?.id ?? null,
          name: existing?.name ?? connectionName,
          baseUrl: url,
          keyChange: typed ? { kind: "replace", key: typed } : { kind: "keep" },
          expectedRevision: existing?.revision ?? null,
        });
        await publish(current);
      }
      const saved = current.saved_connections.find(
        (item) => item.base_url === url,
      );
      if (!saved) throw new Error("The connection was not saved.");
      setConnectionId(saved.id);
      const found = await api.listApiConnectionModels(saved.id, saved.revision);
      setModels(found);
      setModel(modelsFor(found, role)[0]?.id ?? "");
    });

  const use = () =>
    run(async () => {
      const id =
        connectionId ??
        settings.saved_connections.find((item) => item.base_url === url)?.id;
      if (!id) return;
      let next = await api.saveProviderAssignment(
        role,
        { kind: "assigned", connection_id: id, model: model.trim() },
        settings[role]?.revision ?? null,
      );
      if (role === "cloud_stt") next = await api.saveSttMode("cloud");
      await publish(next);
      setNotice(
        `Using ${model.trim()}. Saved on this device; no meeting content was sent.`,
      );
    });

  return (
    <div className="setup-connect">
      {!server && (
        <>
          <label>
            Provider
            <select
              aria-label="Provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              {presets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
              <option value={CUSTOM_PROVIDER}>Custom</option>
            </select>
          </label>
          {preset ? (
            <p className="muted mono" role="note">
              {hostOf(preset.baseUrl)}
            </p>
          ) : (
            <>
              <label>
                Base URL
                <input
                  type="url"
                  value={baseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              {urlError && (
                <p role="alert" className="error">
                  {urlError}
                </p>
              )}
              <label>
                Name <span className="opt">(optional)</span>
                <input
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </>
          )}
        </>
      )}
      {(!server || server.needs_key) && (
        <label>
          API key{server ? ` for ${server.name}` : ""}
          <input
            ref={key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={preset ? `Key from ${preset.keyPage}` : undefined}
          />
        </label>
      )}
      {(!server || server.needs_key || models.length === 0) && (
        <button
          disabled={busy || !url || urlError !== null}
          onClick={() => void connect()}
        >
          Connect and list models
        </button>
      )}
      {(models.length > 0 || connectionId) && (
        <>
          <label>
            Model
            <select
              value={shown.some((item) => item.id === model) ? model : ""}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">Choose a model</option>
              {shown.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={all}
              onChange={(event) => setAll(event.target.checked)}
            />
            <span>Show all models</span>
          </label>
          <label>
            Or type a model ID
            <input
              value={model}
              maxLength={200}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !model.trim()}
            onClick={() => void use()}
          >
            Use this model
          </button>
        </>
      )}
      {assigned && <p className="muted">Current: {assigned.model}</p>}
      {busy && <p role="status">Connecting…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** First-run setup: import, transcription, AI notes, devices, done.
 * Every step can be skipped; Settings → Privacy & about runs it again. */
export function FirstRunSetup(props: Props) {
  const { settings, stt } = props;
  // Nothing to import is the common case; the step only exists when the check says so.
  const [incoming, setIncoming] = useState<ImportStatus | null>(null);
  const [step, setStep] = useState<Step>("transcription");
  const [route, setRoute] = useState<"local" | "api">(
    settings.stt_mode === "cloud" ? "api" : "local",
  );
  const [found, setFound] = useState<LocalModel[] | null>(null);
  const [servers, setServers] = useState<LocalServer[] | null>(null);
  const [notesChoice, setNotesChoice] = useState<string>("");
  const [microphone, setMicrophone] = useState(settings.microphone_id ?? "");
  const [output, setOutput] = useState(settings.output_id ?? "");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState("");
  const [importError, setImportError] = useState("");
  const { busy, error, run } = useTask();
  const publish = (next: Settings) =>
    publishSettings(next, {
      onSaved: props.onSettings,
      onKeyStatus: props.onKeyStatus,
    });

  useEffect(() => {
    let live = true;
    api.importStatus().then(
      (status) => {
        if (!live) return;
        setIncoming(status);
        if (status.available) setStep("import");
      },
      () => undefined,
    );
    api.scanLocalModels(null).then(
      (scan) =>
        live &&
        setFound(
          scan.models
            // The Silero voice-activity file is ggml too, but not a speech model.
            .filter(
              (item) =>
                item.format === "whisper" && !/silero|vad/i.test(item.path),
            )
            .map((item) => ({ ...item, path: displayPath(item.path) })),
        ),
      () => live && setFound([]),
    );
    api.detectLocalServers().then(
      (list) => live && setServers(list),
      () => live && setServers([]),
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const devices = props.devices;
    if (!devices) return;
    setMicrophone((current) =>
      devices.microphones.some((item) => item.id === current)
        ? current
        : (devices.microphones[0]?.id ?? ""),
    );
    setOutput((current) =>
      devices.outputs.some((item) => item.id === current)
        ? current
        : (devices.outputs[0]?.id ?? ""),
    );
  }, [props.devices]);

  const steps: Step[] = incoming?.available
    ? ["import", ...baseSteps]
    : baseSteps;
  const index = steps.indexOf(step);

  const go = (next: Step) => setStep(next);

  const chooseLocal = (model: string, download: boolean) =>
    run(async () => {
      await api.saveSttSettings(
        settings.stt_language,
        settings.stt_prompt,
        model,
      );
      await publish(await api.saveSttMode("local"));
      if (download) props.onInstallStt();
    });

  const finish = async (skip: boolean) => {
    let saved = false;
    await run(async () => {
      if (!skip) {
        if (microphone && output) {
          await api.saveDefaultDevices(microphone, output);
          props.onDevices(microphone, output);
        }
      }
      await publish(await api.saveSetupDone(true));
      saved = true;
    });
    return saved;
  };
  const leave = (next: () => void) =>
    void finish(true).then((saved) => saved && next());

  const importPrevious = () =>
    void (async () => {
      setImporting(true);
      setImportError("");
      setImportResult("");
      try {
        const result = await api.importPrevious();
        setImportResult(
          `Imported ${result.meetings} meetings and ${result.transcript_lines} transcript lines.`,
        );
      } catch (failure) {
        setImportError(
          failure instanceof Error ? failure.message : "The import failed.",
        );
      } finally {
        setImporting(false);
      }
    })();

  const speechServers = (servers ?? []).filter((item) => item.kind !== "chat");
  const speechConnection = settings.provider_assignments.cloud_stt;
  const localReady = settings.stt_mode === "local" && !!stt?.installed;
  const recommended = recommendedSpeechModels(settings.stt_language);
  const primary = recommended[0];
  const primarySize = stt?.models.find((item) => item.id === primary)?.size;

  return (
    <section className="first-run" ref={props.panelRef}>
      <div className="first-run-top">
        <span className="brand">
          <BrandMark size={18} />
          openmeet
        </span>
        <span className="grow" />
        {step !== "done" && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => leave(() => props.onSkipSetup?.())}
          >
            Skip setup
          </button>
        )}
      </div>
      <div className="wizard">
        <ol className="wizard-steps" aria-label="Setup steps">
          {steps.map((name, i) => (
            <li
              key={name}
              aria-current={name === step ? "step" : undefined}
              className={
                name === step ? "current" : i < index ? "done" : undefined
              }
            >
              <span>{i + 1}</span>
              {stepLabels[name]}
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {step === "import" && incoming && (
            <section className="wizard-step" aria-labelledby="setup-import">
              <h1 id="setup-import">Bring your meetings over</h1>
              <p className="help">
                Found meetings from the previous OpenMeet. They are copied
                read-only: nothing is deleted, and API keys are not copied.
              </p>
              <div className="card found">
                <div className="counts">
                  {incoming.meetings} meetings
                  <span className="sep">·</span>
                  {incoming.audio_files} recordings
                  <span className="sep">·</span>
                  {formatBytes(incoming.bytes)}
                </div>
                <div className="path">{incoming.path}</div>
                <div className="found-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={importing || importResult !== ""}
                    onClick={importPrevious}
                  >
                    {importing ? "Importing…" : "Import"}
                  </button>
                </div>
              </div>
              {importResult && <p role="status">{importResult}</p>}
              {importError && <p role="alert">{importError}</p>}
            </section>
          )}

          {step === "transcription" && (
            <section
              className="wizard-step"
              aria-labelledby="setup-transcription"
            >
              <h1 id="setup-transcription">How should we transcribe?</h1>
              <div className="choices">
                <label className="choice">
                  <input
                    type="radio"
                    className="radio"
                    name="stt-route"
                    checked={route === "local"}
                    onChange={() => {
                      setRoute("local");
                    }}
                  />
                  <span>
                    <span className="head">
                      <strong>On this PC</strong>
                      <span className="tag">Recommended</span>
                    </span>
                    <span className="sub">Private and free</span>
                  </span>
                </label>
                <label className="choice">
                  <input
                    type="radio"
                    className="radio"
                    name="stt-route"
                    checked={route === "api"}
                    onChange={() => {
                      setRoute("api");
                    }}
                  />
                  <span>
                    <span className="head">
                      <strong>Cloud service</strong>
                    </span>
                    <span className="sub">Your own API</span>
                  </span>
                </label>
              </div>

              {route === "local" && (
                <div className="wizard-block">
                  <div className="pick">
                    <span className="pick-main">
                      <span className="pick-name">
                        {speechModelLabel(primary)}
                      </span>
                      {primarySize && (
                        <span className="pick-meta">
                          {formatBytes(primarySize)}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="sm"
                      disabled={busy || props.installing}
                      onClick={() => void chooseLocal(primary, true)}
                    >
                      {settings.stt_model === primary && stt?.installed
                        ? "In use"
                        : props.installing
                          ? "Downloading…"
                          : "Download"}
                    </button>
                  </div>
                  {props.sttProgress && (
                    <p className="pick-meta mono" role="status">
                      Downloading {props.sttProgress.stage}:{" "}
                      {formatBytes(props.sttProgress.downloaded)} /{" "}
                      {formatBytes(props.sttProgress.total)}
                    </p>
                  )}
                  {localReady && (
                    <p className="saved" role="status">
                      Ready: {speechModelLabel(settings.stt_model)}
                    </p>
                  )}
                  {found !== null && found.length > 0 && (
                    <details>
                      <summary>Use a model I already have</summary>
                      <ul
                        className="wizard-list"
                        aria-label="Installed Whisper models"
                      >
                        {found.map((item) => {
                          // OpenMeet's own download of the selected pinned model is in use too.
                          const inUse =
                            settings.stt_model === item.path ||
                            (item.model_id === settings.stt_model &&
                              /dev\.openmeet\.preview[\\/]stt[\\/]models[\\/]/i.test(
                                item.path,
                              ));
                          return (
                            <li key={item.path}>
                              <span className="pick-main">
                                <span className="pick-name">
                                  {fileName(item.path)}
                                </span>
                                <span className="pick-meta">
                                  {formatBytes(item.size)} · {item.path}
                                </span>
                              </span>
                              <button
                                type="button"
                                className="sm"
                                disabled={busy || inUse}
                                aria-label={
                                  inUse
                                    ? undefined
                                    : `Use ${fileName(item.path)}`
                                }
                                onClick={() =>
                                  void chooseLocal(item.path, true)
                                }
                              >
                                {inUse ? "In use" : "Use"}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                  <details>
                    <summary>More models</summary>
                    <ul
                      className="wizard-list"
                      aria-label="Recommended downloads"
                    >
                      {recommended.map((id) => {
                        const size = stt?.models.find(
                          (item) => item.id === id,
                        )?.size;
                        return (
                          <li key={id}>
                            <span className="pick-main">
                              <span className="pick-name">
                                {speechModelLabel(id)}
                              </span>
                              {size && (
                                <span className="pick-meta">
                                  {formatBytes(size)}
                                </span>
                              )}
                            </span>
                            <button
                              type="button"
                              className="sm"
                              disabled={busy || props.installing}
                              aria-label={
                                settings.stt_model === id && stt?.installed
                                  ? undefined
                                  : `Download and use ${speechModelLabel(id)}`
                              }
                              onClick={() => void chooseLocal(id, true)}
                            >
                              {settings.stt_model === id && stt?.installed
                                ? "In use"
                                : "Download"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                  {speechServers.length > 0 && (
                    <details>
                      <summary>Speech servers on this computer</summary>
                      {speechServers.map((server) => (
                        <div key={server.base_url} className="wizard-connect">
                          <p className="pick-meta">
                            {server.name} · {server.base_url}
                          </p>
                          <ConnectAndPick
                            role="cloud_stt"
                            settings={settings}
                            server={server}
                            onSettings={props.onSettings}
                            onKeyStatus={props.onKeyStatus}
                          />
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              )}

              {route === "api" && (
                <div className="wizard-fields">
                  <ConnectAndPick
                    role="cloud_stt"
                    settings={settings}
                    server={null}
                    onSettings={props.onSettings}
                    onKeyStatus={props.onKeyStatus}
                  />
                </div>
              )}
            </section>
          )}

          {step === "ai" && (
            <section className="wizard-step" aria-labelledby="setup-ai">
              <h1 id="setup-ai">
                AI notes <span className="opt">(optional)</span>
              </h1>
              <div className="choices">
                {speechConnection && (
                  <label className="choice">
                    <input
                      type="radio"
                      className="radio"
                      name="setup-notes"
                      checked={notesChoice === "speech"}
                      onChange={() => {
                        setNotesChoice("speech");
                      }}
                    />
                    <span>
                      <span className="head">
                        <strong>Transcription connection</strong>
                      </span>
                      <span className="sub">Same connection, a chat model</span>
                    </span>
                  </label>
                )}
                <label className="choice">
                  <input
                    type="radio"
                    className="radio"
                    name="setup-notes"
                    checked={notesChoice === "api"}
                    onChange={() => {
                      setNotesChoice("api");
                    }}
                  />
                  <span>
                    <span className="head">
                      <strong>API service</strong>
                    </span>
                    <span className="sub">Your own API</span>
                  </span>
                </label>
              </div>
              {notesChoice && (
                <div className="wizard-fields">
                  <ConnectAndPick
                    key={notesChoice}
                    role="llm"
                    settings={settings}
                    server={
                      notesChoice === "speech"
                        ? (() => {
                            const saved = settings.saved_connections.find(
                              (item) =>
                                item.id === speechConnection?.connection_id,
                            );
                            return saved
                              ? {
                                  name: saved.name,
                                  base_url: saved.base_url,
                                  kind: "both" as const,
                                  needs_key: false,
                                  models: [],
                                }
                              : null;
                          })()
                        : null
                    }
                    onSettings={props.onSettings}
                    onKeyStatus={props.onKeyStatus}
                  />
                </div>
              )}
              <button
                type="button"
                className="skip-now"
                onClick={() => go("devices")}
              >
                Skip for now
              </button>
            </section>
          )}

          {step === "devices" && (
            <section className="wizard-step" aria-labelledby="setup-devices">
              <h1 id="setup-devices">Pick your devices</h1>
              <p className="help">You can change these later.</p>
              <div className="wizard-fields">
                <label className="field">
                  Microphone
                  <select
                    value={microphone}
                    onChange={(event) => setMicrophone(event.target.value)}
                  >
                    {!microphone && (
                      <option value="">No microphone found</option>
                    )}
                    {props.devices?.microphones.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  System audio
                  <select
                    value={output}
                    onChange={(event) => setOutput(event.target.value)}
                  >
                    {props.devices?.outputs.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="wizard-foot">
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={busy}
                    onClick={props.onRefreshDevices}
                  >
                    Refresh
                  </button>
                </div>
              </div>
            </section>
          )}

          {step === "done" && (
            <section className="wizard-step" aria-labelledby="setup-done">
              <div className="done">
                <span className="done-check" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path
                      d="M4.5 10.5l3.6 3.6L15.5 6.5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h1 id="setup-done">You're set</h1>
              </div>
            </section>
          )}

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>

        <div className="wizard-actions">
          <button
            type="button"
            className="ghost"
            disabled={busy || index <= 0}
            hidden={index <= 0}
            onClick={() => go(steps[index - 1])}
          >
            ← Back
          </button>
          <span className="grow" />
          {step !== "done" ? (
            <>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => go(steps[index + 1])}
              >
                Skip step
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => go(steps[index + 1])}
              >
                Continue
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void finish(false).then(
                    (saved) => saved && props.onOpenSettings(),
                  )
                }
              >
                Open settings
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  void finish(false).then(
                    (saved) => saved && props.onStartMeeting(),
                  )
                }
              >
                Start a meeting
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
