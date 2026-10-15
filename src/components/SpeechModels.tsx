import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type HfFile,
  type HfRepo,
  type HfRepoFiles,
  type SttStatus,
} from "../lib/api";

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
const SCAN_KEY = "openmeet.speechModelScan";
const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Engines other apps (such as Handy) offer that OpenMeet cannot run yet. Listed, never selectable. */
const otherEngines = [
  "Parakeet V2 (NVIDIA Parakeet)",
  "Parakeet V3 (NVIDIA Parakeet)",
  "Moonshine Base",
  "Moonshine V2 Tiny (streaming)",
  "Moonshine V2 Small (streaming)",
  "Moonshine V2 Medium (streaming)",
  "SenseVoice (int8)",
  "GigaAM v3",
  "Canary 180M Flash",
  "Canary 1B v2",
  "Cohere (int8)",
];

function scanDue(): boolean {
  try {
    const last = Number(localStorage.getItem(SCAN_KEY));
    return !last || Date.now() - last > SCAN_INTERVAL_MS;
  } catch {
    return false;
  }
}

function rememberScan() {
  try {
    localStorage.setItem(SCAN_KEY, String(Date.now()));
  } catch {
    // The scan cache is a convenience only.
  }
}

type Props = {
  stt: SttStatus | null;
  selected: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onStatus: (status: SttStatus) => void;
};

export function SpeechModels(props: Props) {
  const { stt, selected, onStatus } = props;
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [repo, setRepo] = useState<HfRepoFiles | null>(null);
  const [confirming, setConfirming] = useState<HfFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const autoScanned = useRef(false);

  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    setError("");
    setScanNote("Scanning drives for speech models…");
    let stop: (() => void) | undefined;
    try {
      stop = await api.onModelScanProgress((folders, found) =>
        setScanNote(
          `Scanning… ${folders} folders checked, ${found} model(s) found.`,
        ),
      );
      const status = await api.scanSpeechModels();
      onStatus(status);
      rememberScan();
      const found = status.models.filter((item) => item.source === "scan");
      setScanNote(
        `Scan finished: ${found.length} model(s) found on this computer.`,
      );
    } catch (failure) {
      setScanNote("");
      setError(errorMessage(failure));
    } finally {
      stop?.();
      setScanning(false);
    }
  };

  // First open (and then weekly): scan once, read-only and local. No network is involved.
  useEffect(() => {
    if (!api.isDesktop() || !stt || autoScanned.current || !scanDue()) return;
    autoScanned.current = true;
    void scan();
  }, [stt === null]);

  const guarded = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const models = stt?.models ?? [];
  const library = models.filter((item) => item.source !== "catalog");
  const catalog = models.filter((item) => item.source === "catalog");
  const known = models.some((item) => item.id === selected);

  return (
    <>
      <label>
        Available speech models
        <select
          value={selected}
          disabled={props.disabled}
          onChange={(event) => props.onSelect(event.target.value)}
        >
          {!known && (
            <option value={selected} disabled>
              {selected} (unavailable)
            </option>
          )}
          {library.length > 0 && (
            <optgroup label="Found on this computer">
              {library.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={!item.installed && item.id !== selected}
                >
                  {item.name ?? item.id} ({mb(item.size)} MB
                  {item.installed ? "" : ", file missing"}
                  {item.source === "huggingface" ? ", Hugging Face" : ""})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Whisper catalog (checked downloads)">
            {catalog.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} ({mb(item.size)} MB
                {item.installed ? ", downloaded" : ""})
              </option>
            ))}
          </optgroup>
          <optgroup label="Other engines (not supported yet)">
            {otherEngines.map((name) => (
              <option key={name} value={`unsupported:${name}`} disabled>
                {name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      <section className="settings-subsection" aria-label="Local model library">
        <h4>Local model library</h4>
        <p className="muted">
          Looks through your drives for whisper.cpp speech models (ggml files).
          Only file names and a 12-byte header are read; nothing leaves this
          device, and files are never moved or deleted.
        </p>
        <div className="panel-actions">
          <button
            disabled={props.disabled || scanning}
            onClick={() => void scan()}
          >
            {scanning ? "Scanning…" : "Scan this computer for models"}
          </button>
          {scanning && (
            <button onClick={() => void api.cancelModelScan()}>
              Cancel scan
            </button>
          )}
        </div>
        {scanNote && (
          <p className="muted" role="status">
            {scanNote}
          </p>
        )}
      </section>

      <section className="settings-subsection" aria-label="Hugging Face models">
        <h4>Hugging Face</h4>
        <p className="muted">
          Search public repositories and download one whisper.cpp model file.
          The search and download contact huggingface.co only when you press the
          buttons.
        </p>
        <form
          className="panel-actions"
          onSubmit={(event) => {
            event.preventDefault();
            void guarded(async () => {
              setRepo(null);
              setConfirming(null);
              setRepos(await api.hfSearch(query));
            });
          }}
        >
          <label>
            Search Hugging Face
            <input
              value={query}
              maxLength={80}
              placeholder="e.g. whisper ggml"
              disabled={props.disabled}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={props.disabled || busy || query.trim().length < 2}
          >
            Search
          </button>
        </form>
        {repos && repos.length === 0 && (
          <p className="muted">No public repositories matched.</p>
        )}
        {repos && repos.length > 0 && (
          <ul className="model-results">
            {repos.map((item) => (
              <li key={item.id}>
                <code>{item.id}</code>{" "}
                <span className="muted">
                  {item.downloads.toLocaleString()} downloads
                </span>{" "}
                <button
                  disabled={props.disabled || busy}
                  aria-label={`Show files of ${item.id}`}
                  onClick={() =>
                    void guarded(async () => {
                      setConfirming(null);
                      setRepo(await api.hfRepoFiles(item.id));
                    })
                  }
                >
                  Show files
                </button>
              </li>
            ))}
          </ul>
        )}
        {repo && (
          <div role="group" aria-label={`Files in ${repo.repo}`}>
            <p>
              <strong>{repo.repo}</strong>{" "}
              <span className="muted">
                License: {repo.license ?? "not stated"} · revision{" "}
                {repo.revision.slice(0, 8)}
              </span>
            </p>
            {repo.files.length === 0 ? (
              <p className="muted">
                This repository has no downloadable .bin model files.
              </p>
            ) : (
              <ul className="model-results">
                {repo.files.map((file) => (
                  <li key={file.name}>
                    <code>{file.name}</code>{" "}
                    <span className="muted">{mb(file.size)} MB</span>{" "}
                    <button
                      disabled={props.disabled || busy || downloading}
                      aria-label={`Review download of ${file.name}`}
                      onClick={() => setConfirming(file)}
                    >
                      Download…
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {repo && confirming && (
          <div
            className="consent-card"
            role="group"
            aria-label="Confirm model download"
          >
            <p>
              <strong>Download this model from Hugging Face?</strong>
            </p>
            <ul>
              <li>
                File: <code>{confirming.name}</code> from{" "}
                <code>{repo.repo}</code> ({mb(confirming.size)} MB)
              </li>
              <li>
                Pinned to revision <code>{repo.revision.slice(0, 12)}</code>;
                SHA-256 <code>{confirming.sha256.slice(0, 16)}…</code> is
                verified after download.
              </li>
              <li>License: {repo.license ?? "not stated"}.</li>
              <li>
                Added by you, not by OpenMeet: this file is checked against
                Hugging Face's published hash, not a hash shipped with the app.
                Only whisper.cpp models are accepted.
              </li>
            </ul>
            <div className="panel-actions">
              <button
                className="primary"
                disabled={props.disabled || downloading}
                onClick={() => {
                  const file = confirming;
                  setConfirming(null);
                  setDownloading(true);
                  void guarded(async () => {
                    try {
                      onStatus(
                        await api.hfDownload(
                          repo.repo,
                          file.name,
                          file.sha256,
                          file.size,
                        ),
                      );
                      setScanNote(
                        `${file.name} downloaded and added to the library.`,
                      );
                    } finally {
                      setDownloading(false);
                    }
                  });
                }}
              >
                Download and verify
              </button>
              <button onClick={() => setConfirming(null)}>Cancel</button>
            </div>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
