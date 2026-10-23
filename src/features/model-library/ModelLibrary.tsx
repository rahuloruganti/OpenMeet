import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type HubFolder,
  type HubKind,
  type HubListing,
  type HubModel,
  type ModelLibraryProgress,
  type ModelScan,
  type SherpaLayout,
} from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";

type Props = {
  disabled: boolean;
  onImported: () => Promise<void>;
  /** Catalog model ids a scan found on disk (not necessarily imported). */
  onFound?: (ids: string[]) => void;
  /** Selects a speech model in the transcription draft: a Whisper file path or a downloaded
   * sherpa-onnx folder id (`sherpa-dir:<name>`). */
  onUse?: (modelId: string) => void;
};

const KIND_LABEL: Record<HubKind, string> = {
  whisper_ggml: "Whisper ggml",
  sherpa_onnx: "sherpa-onnx",
  other: "Other (not downloadable)",
};
const LAYOUT_LABEL: Record<SherpaLayout, string> = {
  transducer: "transducer",
  moonshine: "Moonshine",
  single_model: "single model",
};

export function ModelLibrary({ disabled, onImported, onFound, onUse }: Props) {
  const [scan, setScan] = useState<ModelScan | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubModel[]>([]);
  const [listing, setListing] = useState<HubListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelLibraryProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // The speech model id of the last downloaded sherpa-onnx folder, offered for use.
  const [downloadedId, setDownloadedId] = useState("");
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
        (model) => model.format === "whisper" && model.path === current,
      )
        ? current
        : "",
    );
    onFound?.(foundIds);
  };
  const scanCommon = async () => {
    applyScan(await api.scanLocalModels(null));
  };
  // Mounting the library (first Models tab selection in a Settings session) scans the common model folders once. The scan is local and read-only.
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
  const transfer = (task: () => Promise<void>) =>
    run(async () => {
      transferActive.current = true;
      setDownloading(true);
      setProgress(null);
      try {
        await task();
      } finally {
        transferActive.current = false;
        if (live.current) setDownloading(false);
      }
    });
  const imported = async (id: string) => {
    await onImported();
    if (live.current)
      setNotice(
        `Whisper model ${id} verified and imported. Select it in Available speech models, then save transcription settings.`,
      );
  };
  return (
    <div className="model-library">
      <p className="muted">
        A model file is not a running server. Built-in speech processing uses
        Whisper ggml files and sherpa-onnx folders. GGUF files need an external
        OpenAI-compatible server and are not downloaded here.
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
              (model) => model.format === "whisper",
            );
            const other = scan.models.filter(
              (model) => model.format !== "whisper",
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
                        <option value="">Choose a model</option>
                        {speech.map((model) => (
                          <option key={model.path} value={model.path}>
                            {model.model_id ?? "Custom Whisper"} ·{" "}
                            {formatBytes(model.size)} · {model.path}
                          </option>
                        ))}
                      </select>
                    </label>
                    {chosen?.model_id ? (
                      <button
                        disabled={disabled || busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await api.importLocalModel(
                              chosen.path,
                            );
                            await imported(result.model_id);
                          })
                        }
                      >
                        Verify and import {chosen.model_id}
                      </button>
                    ) : (
                      chosen &&
                      onUse && (
                        <button
                          disabled={disabled || busy}
                          onClick={() => {
                            onUse(chosen.path);
                            setNotice(
                              `${chosen.path} selected. Save transcription settings to use it.`,
                            );
                          }}
                        >
                          Use this file in place
                        </button>
                      )
                    )}
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
                            : "Not a supported Whisper model."}
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
      <h4>Public Hugging Face speech models</h4>
      <p className="muted">
        Search contacts huggingface.co with your query and lists only
        automatic-speech-recognition repositories. Downloads are public files
        with pinned size and SHA-256 verification. Whisper ggml files and
        complete sherpa-onnx folders can be downloaded; other results are shown
        but not downloadable. No private or gated models. Search shows up to 20
        results. Check the displayed license before downloading.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setListing(null);
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
            {model.id} · {KIND_LABEL[model.kind]} · License:{" "}
            {model.license ?? "Not supplied"}{" "}
            {model.kind === "other" ? (
              <span className="muted">Not downloadable.</span>
            ) : (
              <button
                disabled={disabled || busy}
                onClick={() =>
                  void run(async () => {
                    setListing(null);
                    const value = await api.listHfFiles(model.id);
                    if (live.current) setListing(value);
                  })
                }
              >
                Show files for {model.id}
              </button>
            )}
          </li>
        ))}
      </ul>
      {listing && listing.files.length + listing.folders.length === 0 && (
        <p className="muted">
          No complete Whisper ggml files or sherpa-onnx folders in this
          repository.
        </p>
      )}
      <ul>
        {listing?.files.map((file) => (
          <li key={`${file.repo_id}/${file.filename}`}>
            <p>
              {file.repo_id}/{file.filename} · {formatBytes(file.size)} ·
              License: {file.license ?? "Not supplied"}
            </p>
            <p className="muted">
              Revision {file.revision}.{" "}
              {file.model_id
                ? `Matches pinned ${file.model_id}; download verifies the file.`
                : "Whisper ggml file; download verifies its SHA-256 and keeps it in place for use."}
            </p>
            <button
              disabled={disabled || busy}
              onClick={() =>
                transfer(async () => {
                  const result = await api.downloadHfModel(file);
                  if (result.model_id) await imported(result.model_id);
                  else {
                    await scanCommon();
                    if (live.current)
                      setNotice(
                        `Verified file saved to ${result.path}. It is listed under Found speech models; choose it there.`,
                      );
                  }
                })
              }
            >
              Download {file.filename}
            </button>
          </li>
        ))}
        {listing?.folders.map((folder) => (
          <li key={`${folder.repo_id}/${folder.folder}`}>
            <p>
              {folder.repo_id}
              {folder.folder ? `/${folder.folder}` : " (repository root)"} ·
              sherpa-onnx {LAYOUT_LABEL[folder.layout]} ·{" "}
              {formatBytes(folderBytes(folder))} · License:{" "}
              {folder.license ?? "Not supplied"}
            </p>
            <p className="muted">
              Revision {folder.revision}. {folder.files.length} files, each
              checked against its SHA-256. All files are saved or none are.
            </p>
            <button
              disabled={disabled || busy}
              onClick={() =>
                transfer(async () => {
                  const result = await api.downloadHfFolder(folder);
                  if (!live.current) return;
                  setDownloadedId(result.model_id);
                  await onImported();
                  if (live.current)
                    setNotice(
                      `Verified sherpa-onnx folder (${result.files} files) saved to ${result.path}. Use this model, then save transcription settings.`,
                    );
                })
              }
            >
              Download folder {folder.folder || folder.repo_id}
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
      {downloadedId && onUse && (
        <button
          disabled={disabled || busy}
          onClick={() => {
            onUse(downloadedId);
            setNotice(
              "Downloaded model selected. Save transcription settings to use it.",
            );
          }}
        >
          Use this model
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

function folderBytes(folder: HubFolder): number {
  return folder.files.reduce((total, file) => total + file.size, 0);
}
