import { useState, type FormEvent } from "react";
import {
  api,
  errorMessage,
  type LocalAiHfFile,
  type LocalAiHfHit,
  type LocalAiHfListing,
  type LocalAiJob,
  type LocalAiStatus,
} from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";
import { FIT } from "./labels";
import { ProgressJob } from "./LocalAiProgress";

type Props = {
  disabled: boolean;
  /** The key of the action running now; one action runs at a time. */
  busy: string | null;
  job: LocalAiJob | null;
  run: (key: string, task: () => Promise<void>) => Promise<void>;
  apply: (next: LocalAiStatus | null | undefined) => void;
  onCancel: () => void;
};

const COMPACT = new Intl.NumberFormat("en", { notation: "compact" });

/** "1.2K downloads · updated 2025-01-05" */
function hitLine(hit: LocalAiHfHit): string {
  const downloads = `${COMPACT.format(hit.downloads)} downloads`;
  return hit.updated ? `${downloads} · updated ${hit.updated}` : downloads;
}

/** The job and busy key of one file: `owner/repo/file.gguf`. */
function targetOf(repo: string, filename: string): string {
  return `${repo}/${filename}`;
}

/**
 * Finds GGUF models on Hugging Face: a search, one repository's single-file GGUFs with a fit for
 * this PC, and a download that then lists under On this PC. Only the search text is sent away.
 */
export function LocalAiSearch({
  disabled,
  busy,
  job,
  run,
  apply,
  onCancel,
}: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LocalAiHfHit[] | null>(null);
  const [listing, setListing] = useState<LocalAiHfListing | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const request = async (task: () => Promise<void>) => {
    setWorking(true);
    setError("");
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setWorking(false);
    }
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setListing(null);
    void request(async () => setHits(await api.localAiSearchHf(text)));
  };

  const open = (hit: LocalAiHfHit) =>
    void request(async () => setListing(await api.localAiHfFiles(hit.id)));

  const download = (file: LocalAiHfFile) => {
    if (!listing) return;
    const repo = listing.repo_id;
    void run(`hf:${targetOf(repo, file.filename)}`, async () => {
      apply(
        await api.localAiDownloadHf({
          repoId: repo,
          revision: listing.revision,
          filename: file.filename,
          sizeBytes: file.size_bytes,
          sha256: file.sha256,
        }),
      );
      setListing((current) =>
        current && current.repo_id === repo
          ? {
              ...current,
              files: current.files.map((item) =>
                item.filename === file.filename
                  ? { ...item, downloaded: true }
                  : item,
              ),
            }
          : current,
      );
    });
  };

  return (
    <div className="om-card lai-hub">
      <form className="lai-search" role="search" onSubmit={search}>
        <input
          type="search"
          aria-label="Search Hugging Face"
          placeholder="Search models"
          value={query}
          disabled={disabled || working}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="submit"
          className="om-sm"
          disabled={disabled || working || query.trim() === ""}
        >
          Search
        </button>
      </form>
      {working && <p className="om-empty">Working…</p>}
      {error && (
        <p role="alert" className="om-error">
          {error}
        </p>
      )}

      {listing ? (
        <>
          <div className="lai-repo-head">
            <strong>{listing.repo_id}</strong>
            <button
              type="button"
              className="om-ghost om-sm"
              onClick={() => setListing(null)}
            >
              Back
            </button>
          </div>
          {listing.files.length === 0 ? (
            <p className="om-empty">No single-file GGUF to download.</p>
          ) : (
            <ul className="lai-list" aria-label="GGUF files">
              {listing.files.map((file) => {
                const target = targetOf(listing.repo_id, file.filename);
                const here =
                  job && job.kind === "model" && job.target === target
                    ? job
                    : null;
                return (
                  <li key={file.filename} className="lai-file">
                    <span className="lai-what">
                      <strong>{file.filename}</strong>
                      <span className="om-muted">
                        {formatBytes(file.size_bytes)}
                      </span>
                    </span>
                    <span className="om-tag">{FIT[file.fit]}</span>
                    {here ? (
                      <ProgressJob
                        job={here}
                        label="Download progress"
                        cancelLabel="Cancel download"
                        onCancel={onCancel}
                      />
                    ) : file.downloaded ? (
                      <span className="om-muted">On this PC</span>
                    ) : (
                      <button
                        type="button"
                        className="om-sm"
                        aria-label={`Download ${file.filename}`}
                        aria-busy={busy === `hf:${target}`}
                        disabled={
                          disabled || busy !== null || file.fit === "too_big"
                        }
                        onClick={() => download(file)}
                      >
                        {`Download · ${formatBytes(file.size_bytes)}`}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : hits ? (
        hits.length === 0 ? (
          <p className="om-empty">No GGUF models found.</p>
        ) : (
          <ul className="lai-list" aria-label="Search results">
            {hits.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className="lai-hit"
                  disabled={disabled || working}
                  onClick={() => open(hit)}
                >
                  <strong>{hit.id}</strong>
                  <span className="om-muted">{hitLine(hit)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
