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
  /** Every finished scan, so the model menu can offer the files it found. */
  onScan?: (scan: ModelScan) => void;
  /** Selects a speech model in the transcription draft: a Whisper file path or a downloaded
   * sherpa-onnx folder id (`sherpa-dir:<name>`). */
  onUse?: (modelId: string) => void;
};

const KIND_LABEL: Record<HubKind, string> = {
  whisper_ggml: "Speech model file",
  sherpa_onnx: "Speech model folder",
  other: "Not a speech model",
};
const LAYOUT_LABEL: Record<SherpaLayout, string> = {
  transducer: "transducer",
  moonshine: "Moonshine",
  single_model: "single model",
};

export function ModelLibrary({
  disabled,
  onImported,
  onFound,
  onScan,
  onUse,
}: Props) {
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
    onScan?.(value);
  };
  const scanCommon = async () => {
    applyScan(await api.scanLocalModels(null));
  };
  // Mounting the library scans the common model folders once. The scan is local and read-only.
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
        `Whisper model ${id} verified and imported; choose it as the Speech model.`,
      );
  };
  return (
    <div className="model-library">
      <h3 className="model-library-title">Your own models</h3>
      <p className="om-muted">
        Use a model file or folder you already have, or search Hugging Face.
      </p>
      {(disabled || busy) && (
        <p className="om-muted">Wait for the current task to finish.</p>
      )}
      <div className="om-form-actions">
        <button
          type="button"
          className="om-ghost om-sm"
          disabled={disabled || busy}
          title="Each scan checks at most 4,096 entries and six subfolder levels, and lists up to 200 model files. Linked folders are skipped."
          onClick={() => void run(scanCommon)}
        >
          Scan folders
        </button>
        <button
          type="button"
          className="om-ghost om-sm"
          disabled={disabled || busy}
          onClick={() =>
            void run(async () => {
              const folder = await api.chooseModelFolder();
              if (folder === null) return;
              applyScan(await api.scanLocalModels(folder));
            })
          }
        >
          Choose folder
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
            const chosen = speech.find((model) => model.path === picked);
            return (
              <>
                {speech.length === 0 ? (
                  <p className="om-muted">No speech models found.</p>
                ) : (
                  <>
                    <label>
                      Models found on this PC
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
                        type="button"
                        className="om-sm"
                        aria-label={`Verify and import ${chosen.model_id}`}
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
                        Import
                      </button>
                    ) : (
                      chosen &&
                      onUse && (
                        <button
                          type="button"
                          className="om-sm"
                          aria-label="Use this file in place"
                          disabled={disabled || busy}
                          onClick={() => {
                            onUse(chosen.path);
                            setNotice(`${chosen.path} selected.`);
                          }}
                        >
                          Use file
                        </button>
                      )
                    )}
                  </>
                )}
              </>
            );
          })()}
        </>
      )}
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
        <input
          type="search"
          aria-label="Hugging Face search"
          placeholder="Search Hugging Face"
          value={query}
          maxLength={100}
          disabled={disabled || busy}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button disabled={disabled || busy || !query.trim()}>Search</button>
        {!query.trim() && (
          <span className="om-muted">Type a name to search.</span>
        )}
      </form>
      {results.length > 0 &&
        results.every((model) => model.kind === "other") && (
          <p className="om-muted">No compatible models in these results.</p>
        )}
      <ul>
        {results
          .filter((model) => model.kind !== "other")
          .map((model) => (
            <li key={model.id}>
              <span>
                {model.id} · {KIND_LABEL[model.kind]} · License:{" "}
                {model.license ?? "Not supplied"}
              </span>
              <button
                type="button"
                className="om-ghost om-sm"
                aria-label={`Show files for ${model.id}`}
                disabled={disabled || busy}
                onClick={() =>
                  void run(async () => {
                    setListing(null);
                    const value = await api.listHfFiles(model.id);
                    if (live.current) setListing(value);
                  })
                }
              >
                Files
              </button>
            </li>
          ))}
      </ul>
      {listing && listing.files.length + listing.folders.length === 0 && (
        <p className="om-muted">No speech models in this repository.</p>
      )}
      <ul>
        {listing?.files.map((file) => (
          <li key={`${file.repo_id}/${file.filename}`}>
            <span>
              {file.repo_id}/{file.filename} · {formatBytes(file.size)} ·
              License: {file.license ?? "Not supplied"}
            </span>
            <span className="om-muted">
              {file.model_id
                ? `Known model ${file.model_id}. Checked before use.`
                : "Checked before use."}
            </span>
            <details className="om-more">
              <summary>Technical details</summary>
              <span className="om-muted">
                Revision {file.revision}. Each download is checked against its
                SHA-256.
              </span>
            </details>
            <button
              type="button"
              className="om-sm"
              aria-label={`Download ${file.filename}`}
              disabled={disabled || busy}
              onClick={() =>
                transfer(async () => {
                  const result = await api.downloadHfModel(file);
                  if (result.model_id) await imported(result.model_id);
                  else {
                    await scanCommon();
                    if (live.current)
                      setNotice(
                        `Verified file saved to ${result.path}; choose it under Models found on this PC.`,
                      );
                  }
                })
              }
            >
              Download
            </button>
          </li>
        ))}
        {listing?.folders.map((folder) => (
          <li key={`${folder.repo_id}/${folder.folder}`}>
            <span>
              {folder.repo_id}
              {folder.folder
                ? `/${folder.folder}`
                : " (repository root)"} · {KIND_LABEL.sherpa_onnx} ·{" "}
              {formatBytes(folderBytes(folder))} · License:{" "}
              {folder.license ?? "Not supplied"}
            </span>
            <span className="om-muted">
              {folder.files.length} files. All are saved or none are.
            </span>
            <details className="om-more">
              <summary>Technical details</summary>
              <span className="om-muted">
                Layout {LAYOUT_LABEL[folder.layout]}. Revision {folder.revision}
                . Each file is checked against its SHA-256.
              </span>
            </details>
            <button
              type="button"
              className="om-sm"
              aria-label={`Download folder ${folder.folder || folder.repo_id}`}
              disabled={disabled || busy}
              onClick={() =>
                transfer(async () => {
                  const result = await api.downloadHfFolder(folder);
                  if (!live.current) return;
                  setDownloadedId(result.model_id);
                  await onImported();
                  if (live.current)
                    setNotice(
                      `Speech model folder downloaded and verified (${result.files} files), saved to ${result.path}.`,
                    );
                })
              }
            >
              Download
            </button>
          </li>
        ))}
      </ul>
      {downloading && (
        <>
          <p className="om-muted">
            Downloading
            {progress
              ? ` ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
              : " model"}
          </p>
          <button
            type="button"
            className="om-ghost om-sm"
            aria-label="Cancel model download"
            onClick={() =>
              void api
                .cancelModelDownload()
                .catch((failure) => setError(errorMessage(failure)))
            }
          >
            Cancel download
          </button>
        </>
      )}
      {notice && <p className="om-muted">{notice}</p>}
      {downloadedId && onUse && (
        <button
          type="button"
          className="om-sm"
          aria-label="Use this model"
          disabled={disabled || busy}
          onClick={() => {
            onUse(downloadedId);
            setNotice("Downloaded model selected.");
          }}
        >
          Use
        </button>
      )}
      {error && (
        <p role="alert" className="om-error">
          {error}
        </p>
      )}
    </div>
  );
}

function folderBytes(folder: HubFolder): number {
  return folder.files.reduce((total, file) => total + file.size, 0);
}
