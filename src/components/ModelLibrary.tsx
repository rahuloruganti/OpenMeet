import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type HubFile,
  type HubModel,
  type ModelLibraryProgress,
  type ModelScan,
} from "../lib/api";
import { formatBytes } from "../lib/meeting-labels";

type Props = {
  disabled: boolean;
  onImported: () => Promise<void>;
  /** Catalog model ids a scan found on disk (not necessarily imported). */
  onFound?: (ids: string[]) => void;
};
export function ModelLibrary({ disabled, onImported, onFound }: Props) {
  const [scan, setScan] = useState<ModelScan | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubModel[]>([]);
  const [files, setFiles] = useState<HubFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelLibraryProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const live = useRef(true);
  const transferActive = useRef(false);
  useEffect(() => {
    live.current = true;
    const unlisten = api.onModelLibraryProgress((value) => {
      if (live.current) setProgress(value);
    });
    void unlisten.catch(() => {
      if (live.current) setError("Download progress unavailable.");
    });
    return () => {
      live.current = false;
      if (transferActive.current)
        void api.cancelModelDownload().catch(() => {});
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);
  const [picked, setPicked] = useState("");
  const applyScan = (value: ModelScan) => {
    if (!live.current) return;
    const foundIds = value.models.flatMap((model) =>
      model.format === "whisper" && model.model_id ? [model.model_id] : [],
    );
    setScan(value);
    setPicked((current) =>
      value.models.some(
        (model) =>
          model.format === "whisper" &&
          model.model_id &&
          model.path === current,
      )
        ? current
        : "",
    );
    onFound?.(foundIds);
  };
  const scanCommon = async () => {
    applyScan(await api.scanLocalModels(null));
  };
  // Opening Settings scans the common model folders once. The scan is local and read-only.
  useEffect(() => {
    void scanCommon().catch((failure: unknown) => {
      if (live.current) setError(errorMessage(failure));
    });
  }, []);
  const run = async (task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (failure) {
      if (live.current) setError(errorMessage(failure));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const imported = async (id: string) => {
    await onImported();
    if (live.current)
      setNotice(
        `Whisper model ${id} verified and imported. Select it in Available speech models, then save transcription settings.`,
      );
  };
  return (
    <section className="model-library" aria-label="Local model library">
      <h3>Local model library</h3>
      <p className="muted">
        A model file is not a running server. GGUF files require an external
        OpenAI-compatible server. Only verified catalog Whisper models can be
        imported for built-in speech processing.
      </p>
      <p className="muted">
        Each scan checks at most 4,096 entries and six subfolder levels, and
        lists up to 200 model files. Linked folders are skipped. Choose a
        smaller folder if the scan reaches a limit.
      </p>
      <div className="panel-actions">
        <button
          disabled={disabled || busy}
          onClick={() => void run(scanCommon)}
        >
          Scan common folders
        </button>
        <button
          disabled={disabled || busy}
          onClick={() =>
            void run(async () => {
              const folder = await api.chooseModelFolder();
              if (folder === null) return;
              applyScan(await api.scanLocalModels(folder));
            })
          }
        >
          Choose model folder
        </button>
      </div>
      {scan && (
        <>
          <ul>
            {scan.folders.map((folder) => (
              <li key={folder.path}>
                {folder.path}: {folder.status}
              </li>
            ))}
          </ul>
          {scan.truncated && (
            <p>
              Scan limit reached. Choose a smaller folder to find more files.
            </p>
          )}
          {(() => {
            const speech = scan.models.filter(
              (model) => model.format === "whisper" && model.model_id,
            );
            const other = scan.models.filter(
              (model) => !(model.format === "whisper" && model.model_id),
            );
            const chosen = speech.find((model) => model.path === picked);
            return (
              <>
                {speech.length === 0 ? (
                  <p>No speech models found.</p>
                ) : (
                  <>
                    <label>
                      Found speech models
                      <select
                        value={picked}
                        disabled={disabled || busy}
                        onChange={(event) => setPicked(event.target.value)}
                      >
                        <option value="">Choose a model to import</option>
                        {speech.map((model) => (
                          <option key={model.path} value={model.path}>
                            {model.model_id} · {formatBytes(model.size)} ·{" "}
                            {model.path}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={disabled || busy || !chosen}
                      onClick={() =>
                        chosen &&
                        void run(async () => {
                          const result = await api.importLocalModel(
                            chosen.path,
                          );
                          await imported(result.model_id);
                        })
                      }
                    >
                      {chosen
                        ? "Verify and import " + chosen.model_id
                        : "Verify and import"}
                    </button>
                  </>
                )}
                {other.length > 0 && (
                  <ul aria-label="Other discovered model files">
                    {other.map((model) => (
                      <li key={model.path}>
                        <p>
                          {model.path} · {model.format} ·{" "}
                          {formatBytes(model.size)}
                        </p>
                        <p className="muted">
                          {model.format === "gguf"
                            ? "Use with an external server. Inference compatibility unverified."
                            : "Not a supported Whisper catalog candidate."}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()}
        </>
      )}
      <h4>Public Hugging Face models</h4>
      <p className="muted">
        Search contacts huggingface.co with your query. Downloads are public
        single files with pinned size and SHA-256 verification. No private or
        gated models. Search shows up to 20 results. Check the displayed license
        before downloading.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setFiles([]);
            const value = await api.searchHfModels(query.trim());
            if (live.current) setResults(value);
          });
        }}
      >
        <label>
          Hugging Face search
          <input
            value={query}
            maxLength={100}
            disabled={disabled || busy}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button disabled={disabled || busy || !query.trim()}>
          Search public models
        </button>
      </form>
      <ul>
        {results.map((model) => (
          <li key={model.id}>
            {model.id} · License: {model.license ?? "Not supplied"}{" "}
            <button
              disabled={disabled || busy}
              onClick={() =>
                void run(async () => {
                  setFiles([]);
                  const value = await api.listHfFiles(model.id);
                  if (live.current) setFiles(value);
                })
              }
            >
              Show files for {model.id}
            </button>
          </li>
        ))}
      </ul>
      <ul>
        {files.map((file) => (
          <li key={`${file.repo_id}/${file.filename}`}>
            <p>
              {file.repo_id}/{file.filename} · {formatBytes(file.size)} ·
              License: {file.license ?? "Not supplied"}
            </p>
            <p className="muted">
              Revision {file.revision}.{" "}
              {file.model_id
                ? "Whisper catalog candidate; download verifies the file."
                : "Requires an external server. Inference compatibility unverified."}
            </p>
            <button
              disabled={disabled || busy}
              onClick={() =>
                void run(async () => {
                  transferActive.current = true;
                  setDownloading(true);
                  setProgress(null);
                  try {
                    const result = await api.downloadHfModel(file);
                    if (result.model_id) await imported(result.model_id);
                    else if (live.current)
                      setNotice(
                        `Verified file downloaded to ${result.path}. Configure an external server to use it.`,
                      );
                  } finally {
                    transferActive.current = false;
                    if (live.current) setDownloading(false);
                  }
                })
              }
            >
              Download {file.filename}
            </button>
          </li>
        ))}
      </ul>
      {downloading && (
        <>
          <p role="status">
            Downloading
            {progress
              ? ` ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
              : " model"}
          </p>
          <button
            onClick={() =>
              void api
                .cancelModelDownload()
                .catch((failure) => setError(errorMessage(failure)))
            }
          >
            Cancel model download
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
