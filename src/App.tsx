import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type Meeting,
  type MeetingDetail,
  type AudioDevices,
  type AudioHealth,
  type RecordingState,
  type Settings,
} from "./lib/api";
import { createNoteWriter } from "./lib/note-writer";

type Writer = ReturnType<typeof createNoteWriter>;

export function App() {
  const desktop = api.isDesktop();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<MeetingDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [notesStatus, setNotesStatus] = useState("saved");
  const writer = useRef<Writer | null>(null);
  const [recording, setRecording] = useState<RecordingState>({
    revision: 0,
    status: "idle",
    meeting_id: null,
    source: null,
    error: null,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [title, setTitle] = useState("Untitled meeting");
  const [consent, setConsent] = useState(false);
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [microphone, setMicrophone] = useState("");
  const [output, setOutput] = useState("");
  const [health, setHealth] = useState<AudioHealth | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const listRequest = useRef(0);

  const refreshList = useCallback(async () => {
    const request = ++listRequest.current;
    const list = await api.listMeetings();
    if (request === listRequest.current) setMeetings(list);
    return list;
  }, []);

  const updateRecording = useCallback((next: RecordingState) => {
    setRecording((previous) =>
      next.revision >= previous.revision ? next : previous,
    );
  }, []);

  const openMeeting = useCallback(async (id: string) => {
    await writer.current?.flush();
    const detail = await api.getMeeting(id);
    writer.current?.dispose();
    writer.current = createNoteWriter(
      detail.user_markdown,
      detail.notes_revision,
      (text, revision) => api.saveNotes(id, text, revision),
      (status, failure) => {
        setNotesStatus(status);
        if (failure) setError(errorMessage(failure));
      },
    );
    setNotes(detail.user_markdown);
    setNotesStatus("saved");
    setSelected(detail);
  }, []);

  const run = useCallback(async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const listeners: (() => void)[] = [];
    const register = async (subscription: Promise<() => void>) => {
      const unlisten = await subscription;
      if (disposed) unlisten();
      else listeners.push(unlisten);
    };
    void (async () => {
      // Listen before reading state so startup cannot miss tray/shortcut changes.
      await register(api.onRecordingState(updateRecording));
      await register(
        api.onMeetingUpdated(() => {
          void refreshList().catch((failure: unknown) =>
            setError(errorMessage(failure)),
          );
        }),
      );
      await register(api.onCloseRequested(() => setCloseRequested(true)));
      await register(api.onError(setError));
      await register(api.onAudioHealth(setHealth));
      if (disposed) return;
      const [state, preferences, warning, discovered] = await Promise.all([
        api.getRecordingState(),
        api.getSettings(),
        api.getStartupWarning(),
        api.listDevices(),
      ]);
      if (disposed) return;
      updateRecording(state);
      setSettings(preferences);
      setShortcut(preferences.pause_shortcut);
      setDevices(discovered);
      setMicrophone(
        preferences.microphone_id ?? discovered.microphones[0]?.id ?? "",
      );
      setOutput(preferences.output_id ?? discovered.outputs[0]?.id ?? "");
      if (warning) setError(warning);
      const list = await refreshList();
      if (disposed) return;
      if (list[0]) await openMeeting(list[0].id);
      if (!disposed) setReady(true);
    })().catch((failure: unknown) => {
      if (!disposed) setError(errorMessage(failure));
    });
    return () => {
      disposed = true;
      for (const unlisten of listeners) unlisten();
      writer.current?.dispose();
    };
  }, [desktop, openMeeting, refreshList, updateRecording]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (writer.current?.isDirty()) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const active =
    recording.status === "recording" || recording.status === "paused";
  const disabled = !ready || busy;

  return (
    <div className="app">
      <header>
        <div>
          <span className="eyebrow">LOCAL-FIRST MEETING NOTES</span>
          <h1>OpenMeet</h1>
        </div>
        <div className={`recording-state ${recording.status}`} role="status">
          <span aria-hidden="true">●</span>{" "}
          {recording.source === "desktop" ? "Recording" : "Simulation"}:{" "}
          {recording.status}
        </div>
      </header>
      <p className="preview-banner">
        <strong>Windows capture preview.</strong> Real recording saves
        microphone and system audio locally. Transcription and AI summaries are
        not implemented. macOS capture is not yet available.
      </p>
      {!desktop && (
        <p role="alert">
          Open this app with <code>corepack pnpm tauri dev</code>. The browser
          preview cannot access the desktop database; it does not simulate
          persistence.
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error} <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {desktop && !ready && !error && (
        <p role="status">Opening local database…</p>
      )}

      <section className="recorder" aria-label="Recording controls">
        <label>
          Meeting title
          <input
            value={title}
            maxLength={160}
            disabled={disabled || active}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            disabled={disabled || active}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I have informed participants and have consent to record microphone and
          system audio.
        </label>
        <div className="actions">
          <label>
            Microphone
            <select
              value={microphone}
              disabled={disabled || active || !devices?.capture_supported}
              onChange={(event) => setMicrophone(event.target.value)}
            >
              {devices?.microphones.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            System output
            <select
              value={output}
              disabled={disabled || active || !devices?.capture_supported}
              onChange={(event) => setOutput(event.target.value)}
            >
              {devices?.outputs.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={
              disabled ||
              active ||
              !consent ||
              !title.trim() ||
              !devices?.capture_supported ||
              !microphone ||
              !output
            }
            onClick={() =>
              void run(async () => {
                await writer.current?.flush();
                const state = await api.startCapture(title, consent, {
                  microphoneId: microphone,
                  outputId: output,
                });
                updateRecording(state);
                if (state.meeting_id) await openMeeting(state.meeting_id);
                await refreshList();
              })
            }
          >
            Start recording
          </button>
          <button
            disabled={disabled || active || !title.trim()}
            onClick={() =>
              void run(async () => {
                await writer.current?.flush();
                const state = await api.start(title);
                updateRecording(state);
                if (state.meeting_id) await openMeeting(state.meeting_id);
                await refreshList();
              })
            }
          >
            Start simulation
          </button>
          <button
            disabled={disabled || !active}
            onClick={() =>
              void run(async () => {
                updateRecording(
                  await (recording.status === "paused"
                    ? api.resume()
                    : api.pause()),
                );
              })
            }
          >
            {recording.status === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            disabled={disabled || !active}
            onClick={() =>
              void run(async () => {
                await writer.current?.flush();
                updateRecording(await api.stop());
                await refreshList();
              })
            }
          >
            Stop
          </button>
        </div>
      </section>

      <main>
        <aside>
          <div className="section-heading">
            <h2>Meetings</h2>
            <button
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await writer.current?.flush();
                  const id = await api.createFixture();
                  await refreshList();
                  await openMeeting(id);
                })
              }
            >
              Load sample
            </button>
          </div>
          {health && (
            <p className="muted">
              {health.error ??
                health.tracks
                  .map(
                    (track) =>
                      `${track.kind}: ${track.frames} frames, peak ${track.peak.toFixed(2)}`,
                  )
                  .join(" · ")}
            </p>
          )}
          {meetings.length === 0 && (
            <p className="muted">
              No meetings yet. Load the fictional sample or start a simulation.
            </p>
          )}
          <ul className="meeting-list">
            {meetings.map((meeting) => (
              <li key={meeting.id}>
                <button
                  disabled={disabled}
                  aria-current={
                    selected?.meeting.id === meeting.id ? "true" : undefined
                  }
                  onClick={() => void run(() => openMeeting(meeting.id))}
                >
                  <strong>{meeting.title}</strong>
                  <span>
                    {meeting.source} · {meeting.status}
                  </span>
                  <time dateTime={meeting.started_at}>
                    {new Date(meeting.started_at).toLocaleString()}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <article>
          {selected ? (
            <>
              <div className="section-heading">
                <h2>{selected.meeting.title}</h2>
                <button
                  disabled={disabled}
                  onClick={() =>
                    void run(async () => {
                      await writer.current?.flush();
                      const result = await api.exportMeeting(
                        selected.meeting.id,
                      );
                      setNotice(
                        `${result.created_copy ? "Existing file preserved; created a new snapshot" : "Exported"}: ${result.path}`,
                      );
                    })
                  }
                >
                  Export Markdown
                </button>
              </div>
              <label htmlFor="notes">
                My notes <span className="muted">({notesStatus})</span>
              </label>
              <textarea
                id="notes"
                value={notes}
                disabled={disabled}
                rows={10}
                placeholder="Your own notes stay separate from generated content."
                onChange={(event) => {
                  setNotes(event.target.value);
                  writer.current?.update(event.target.value);
                }}
              />
              <button
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    await writer.current?.flush();
                  })
                }
              >
                Save notes now
              </button>
              <h3>
                {selected.meeting.source === "fixture"
                  ? "Sample summary (hand-written)"
                  : "Summary"}
              </h3>
              <pre>
                {selected.summary ??
                  "No summary generated. AI processing is not available in this preview."}
              </pre>
              <h3>Transcript</h3>
              {selected.tracks.length > 0 && (
                <p className="muted">
                  {selected.tracks
                    .map((track) => `${track.kind}: ${track.path}`)
                    .join("\n")}
                </p>
              )}
              {selected.segments.length === 0 && (
                <p className="muted">
                  No transcript. Transcription is not implemented yet.
                </p>
              )}
              {selected.segments.map((segment, index) => (
                <p key={index}>
                  <strong>{segment.speaker}</strong>{" "}
                  <span className="muted">
                    {(segment.start_ms / 1000).toFixed(1)}s
                  </span>{" "}
                  — {segment.text}
                </p>
              ))}
            </>
          ) : (
            <div className="empty">
              <h2>Your meeting notes, on your device.</h2>
              <p>
                Select a meeting to edit notes and export a Markdown snapshot.
              </p>
            </div>
          )}
        </article>
      </main>

      <details className="settings">
        <summary>Settings</summary>
        <p>
          <strong>Storage:</strong> SQLite in the OS app-data folder. No network
          requests, telemetry, or cloud processing in this preview.
        </p>
        <label>
          Export folder
          <output>{settings?.vault_folder ?? "Not selected"}</output>
        </label>
        <button
          disabled={disabled}
          onClick={() =>
            void run(async () => {
              setSettings(await api.chooseVaultFolder());
            })
          }
        >
          Choose export folder
        </button>
        <label>
          Pause / resume shortcut
          <input
            value={shortcut}
            disabled={disabled}
            onChange={(event) => setShortcut(event.target.value)}
            placeholder="CommandOrControl+Shift+Space"
          />
        </label>
        <button
          disabled={disabled || !shortcut.trim()}
          onClick={() =>
            void run(async () => {
              const updated = await api.saveSettings(shortcut);
              setSettings(updated);
              setShortcut(updated.pause_shortcut);
              setNotice("Shortcut saved.");
            })
          }
        >
          Save shortcut
        </button>
      </details>
      <footer>
        Phase 1A · Foundation preview · Files are local and unencrypted. Choose
        your export folder carefully.
      </footer>
      {closeRequested && (
        <section
          className="close-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="close-title"
        >
          <h2 id="close-title">Save and quit?</h2>
          <p>
            Your notes will be saved first. Any active simulation will stop.
          </p>
          <button
            autoFocus
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await writer.current?.flush();
                await api.close();
              })
            }
          >
            Save and quit
          </button>
          <button disabled={busy} onClick={() => setCloseRequested(false)}>
            Keep working
          </button>
        </section>
      )}
    </div>
  );
}
