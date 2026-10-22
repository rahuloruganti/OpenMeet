import { useEffect, useRef, useState, type Ref } from "react";
import {
  api,
  type AudioDevices,
  type KeyStatus,
  type LocalModel,
  type LocalServer,
  type ProviderModel,
  type ProviderRole,
  type Settings,
  type SttDownloadProgress,
  type SttStatus,
} from "../lib/api";
import { displayPath, formatBytes } from "../lib/meeting-labels";
import { modelsFor } from "../lib/models";
import { useTask } from "../lib/use-task";
import { destination, publishSettings } from "./ProviderSettings";

const steps = ["Welcome", "Transcription", "AI notes", "Devices"] as const;
/** Downloads offered when nothing usable is on disk: English-first, then any language. */
const recommended = [
  ["base.en-q5_1", "English, fast and small"],
  ["small", "Any language, more accurate"],
] as const;

type Props = {
  panelRef: Ref<HTMLElement>;
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
};

/** Connects a server or API, then picks a model for one task. Keys go straight to the OS
 * keychain through Rust; the field is uncontrolled and cleared after use. */
function ConnectAndPick(props: {
  role: ProviderRole;
  settings: Settings;
  /** A detected local server; null lets the user type any OpenAI-compatible API. */
  server: LocalServer | null;
  onSettings: (settings: Settings) => void;
  onKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
}) {
  const { role, settings, server } = props;
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

  const connect = () =>
    run(async () => {
      const typed = key.current?.value ?? "";
      if (key.current) key.current.value = "";
      const url = baseUrl.trim();
      const existing = settings.saved_connections.find(
        (item) => item.base_url === url,
      );
      let current = settings;
      if (!existing || typed) {
        current = await api.saveApiConnection({
          id: existing?.id ?? null,
          name: existing?.name ?? name.trim(),
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
        settings.saved_connections.find((item) => item.base_url === baseUrl)
          ?.id;
      if (!id) return;
      let next = await api.saveProviderAssignment(
        role,
        { kind: "assigned", connection_id: id, model: model.trim() },
        settings[role]?.revision ?? null,
      );
      if (role === "cloud_stt") next = await api.saveSttMode("cloud");
      await publish(next);
      setNotice(`Using ${model.trim()}. No meeting content was sent.`);
    });

  return (
    <div className="setup-connect">
      {!server && (
        <>
          <label>
            Name
            <input
              value={name}
              maxLength={100}
              placeholder="My provider"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            API base URL
            <input
              type="url"
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
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
          />
        </label>
      )}
      {(!server || server.needs_key || models.length === 0) && (
        <button
          disabled={busy || !baseUrl.trim() || (!server && !name.trim())}
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
      {assigned && (
        <p className="muted">
          Current: {assigned.model} ·{" "}
          {destination(
            settings.saved_connections.find(
              (item) => item.id === assigned.connection_id,
            )?.base_url ?? "",
          )}
        </p>
      )}
      {busy && <p role="status">Working…</p>}
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

/** First-run setup: where data lives, how to transcribe, AI notes, and default devices.
 * Every step can be skipped; Settings → Privacy & about runs it again. */
export function FirstRunSetup(props: Props) {
  const { settings, stt } = props;
  const [step, setStep] = useState(0);
  const [route, setRoute] = useState<"local" | "api">(
    settings.stt_mode === "cloud" ? "api" : "local",
  );
  const [found, setFound] = useState<LocalModel[] | null>(null);
  const [servers, setServers] = useState<LocalServer[] | null>(null);
  const [notesChoice, setNotesChoice] = useState<string>("");
  const [auto, setAuto] = useState(true);
  const [microphone, setMicrophone] = useState(settings.microphone_id ?? "");
  const [output, setOutput] = useState(settings.output_id ?? "");
  const { busy, error, run } = useTask();
  const publish = (next: Settings) =>
    publishSettings(next, {
      onSaved: props.onSettings,
      onKeyStatus: props.onKeyStatus,
    });

  useEffect(() => {
    let live = true;
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

  const finish = (skip: boolean) =>
    run(async () => {
      if (!skip) {
        if (microphone && output) {
          await api.saveDefaultDevices(microphone, output);
          props.onDevices(microphone, output);
        }
        await api.saveProcessingDefault(
          auto ? "final" : "recording",
          auto && settings.provider_assignments.llm ? "general-v1" : null,
        );
      }
      await publish(await api.saveSetupDone(true));
    });

  const chat = (servers ?? []).filter((item) => item.kind !== "speech");
  const speechServers = (servers ?? []).filter((item) => item.kind !== "chat");
  const speechConnection = settings.provider_assignments.cloud_stt;
  const localReady = settings.stt_mode === "local" && !!stt?.installed;

  return (
    <section
      className="workspace-panel setup first-run"
      ref={props.panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="first-run-title"
    >
      <div className="panel-heading">
        <h2 id="first-run-title">Set up OpenMeet</h2>
        <button disabled={busy} onClick={() => void finish(true)}>
          Skip setup
        </button>
      </div>
      <ol className="setup-steps" aria-label="Setup steps">
        {steps.map((label, index) => (
          <li key={label} aria-current={index === step ? "step" : undefined}>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div>
          <p>
            OpenMeet records your microphone and the audio of your other apps,
            transcribes it, and writes AI notes. Recordings, notes and
            transcripts stay on this computer, unencrypted, unless you choose an
            online service below.
          </p>
          <p>
            <strong>Recording consent is your responsibility.</strong> Tell
            people when you record them and follow the laws where you and they
            are.
          </p>
        </div>
      )}

      {step === 1 && (
        <div>
          <fieldset className="choice-cards">
            <legend>How should meetings be transcribed?</legend>
            <label className="choice-card">
              <input
                type="radio"
                name="setup-route"
                checked={route === "local"}
                onChange={() => setRoute("local")}
              />
              <span>
                <strong>On this computer</strong>
                <span className="muted">
                  Free and private. Uses a Whisper model on your CPU.
                </span>
              </span>
            </label>
            <label className="choice-card">
              <input
                type="radio"
                name="setup-route"
                checked={route === "api"}
                onChange={() => setRoute("api")}
              />
              <span>
                <strong>Online API</strong>
                <span className="muted">
                  Audio is uploaded to the service you choose.
                </span>
              </span>
            </label>
          </fieldset>
          {route === "local" ? (
            <>
              <h3>Whisper models on this computer</h3>
              {found === null ? (
                <p role="status">Looking for installed models…</p>
              ) : found.length === 0 ? (
                <p className="muted">No Whisper models found.</p>
              ) : (
                <ul
                  className="setup-list"
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
                        <span>
                          <strong>{fileName(item.path)}</strong>{" "}
                          <span className="muted">
                            {formatBytes(item.size)} ·{" "}
                            {item.model_id
                              ? `matches pinned ${item.model_id}`
                              : "custom"}{" "}
                            · {item.path}
                          </span>
                        </span>
                        <button
                          disabled={busy || inUse}
                          onClick={() => void chooseLocal(item.path, true)}
                        >
                          {inUse ? "In use" : "Use"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <h3>Or download a model</h3>
              <ul className="setup-list" aria-label="Recommended downloads">
                {recommended.map(([id, note]) => {
                  const size = stt?.models.find((item) => item.id === id)?.size;
                  return (
                    <li key={id}>
                      <span>
                        <strong>Whisper {id}</strong>{" "}
                        <span className="muted">
                          {note}
                          {size ? ` · ${formatBytes(size)}` : ""}
                        </span>
                      </span>
                      <button
                        disabled={busy || props.installing}
                        onClick={() => void chooseLocal(id, true)}
                      >
                        {settings.stt_model === id && stt?.installed
                          ? "In use"
                          : "Download and use"}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {props.sttProgress && (
                <p role="status">
                  Downloading {props.sttProgress.stage}:{" "}
                  {formatBytes(props.sttProgress.downloaded)} /{" "}
                  {formatBytes(props.sttProgress.total)}
                </p>
              )}
              {localReady && (
                <p role="status">
                  Ready: {fileName(settings.stt_model)} on this computer.
                </p>
              )}
              {speechServers.length > 0 && (
                <>
                  <h3>Speech servers on this computer</h3>
                  {speechServers.map((server) => (
                    <details key={server.base_url}>
                      <summary>
                        {server.name} · {server.base_url}
                      </summary>
                      <ConnectAndPick
                        role="cloud_stt"
                        settings={settings}
                        server={server}
                        onSettings={props.onSettings}
                        onKeyStatus={props.onKeyStatus}
                      />
                    </details>
                  ))}
                </>
              )}
            </>
          ) : (
            <ConnectAndPick
              role="cloud_stt"
              settings={settings}
              server={null}
              onSettings={props.onSettings}
              onKeyStatus={props.onKeyStatus}
            />
          )}
        </div>
      )}

      {step === 2 && (
        <div>
          <p>
            AI notes write summaries and answer questions about a meeting. They
            need a chat model, on this computer or online. You can skip this.
          </p>
          {servers === null && (
            <p role="status">Looking for AI servers on this computer…</p>
          )}
          {servers !== null && chat.length === 0 && (
            <p className="muted">
              No local AI server found. Install Ollama (ollama.com) or LM Studio
              (lmstudio.ai), start it, and run setup again from Settings.
            </p>
          )}
          <fieldset className="choice-cards">
            <legend>Where should AI notes run?</legend>
            {chat.map((server) => (
              <label className="choice-card" key={server.base_url}>
                <input
                  type="radio"
                  name="setup-notes"
                  checked={notesChoice === server.base_url}
                  onChange={() => setNotesChoice(server.base_url)}
                />
                <span>
                  <strong>{server.name} on this computer</strong>
                  <span className="muted">
                    {server.needs_key
                      ? "Needs its API key."
                      : `${server.models.length} model${server.models.length === 1 ? "" : "s"} found.`}
                  </span>
                </span>
              </label>
            ))}
            {speechConnection && (
              <label className="choice-card">
                <input
                  type="radio"
                  name="setup-notes"
                  checked={notesChoice === "speech"}
                  onChange={() => setNotesChoice("speech")}
                />
                <span>
                  <strong>The transcription connection</strong>
                  <span className="muted">Same provider, a chat model.</span>
                </span>
              </label>
            )}
            <label className="choice-card">
              <input
                type="radio"
                name="setup-notes"
                checked={notesChoice === "api"}
                onChange={() => setNotesChoice("api")}
              />
              <span>
                <strong>Another online API</strong>
                <span className="muted">
                  Notes and transcript text are sent to it.
                </span>
              </span>
            </label>
          </fieldset>
          {notesChoice && (
            <ConnectAndPick
              key={notesChoice}
              role="llm"
              settings={settings}
              server={
                chat.find((item) => item.base_url === notesChoice) ??
                (notesChoice === "speech"
                  ? (() => {
                      const saved = settings.saved_connections.find(
                        (item) => item.id === speechConnection?.connection_id,
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
                  : null)
              }
              onSettings={props.onSettings}
              onKeyStatus={props.onKeyStatus}
            />
          )}
        </div>
      )}

      {step === 3 && (
        <div>
          <label>
            Microphone
            <select
              value={microphone}
              onChange={(event) => setMicrophone(event.target.value)}
            >
              {!microphone && <option value="">No microphone found</option>}
              {props.devices?.microphones.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
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
          <button disabled={busy} onClick={props.onRefreshDevices}>
            Refresh devices
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            <span>
              Transcribe every recording when it stops
              {settings.provider_assignments.llm ? ", then summarize it" : ""}
            </span>
          </label>
        </div>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="panel-actions">
        {step > 0 && (
          <button disabled={busy} onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < steps.length - 1 ? (
          <button className="primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void finish(false)}
          >
            Finish
          </button>
        )}
      </div>
    </section>
  );
}
