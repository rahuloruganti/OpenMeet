import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  isLocalBase,
  type Meeting,
  type MeetingDetail,
  type KeyStatus,
  type ProviderRole,
  type ProcessingPlan,
  type SttDownloadProgress,
  type SttStatus,
  type AudioDevices,
  type AudioHealth,
  type RecordingState,
  type SearchHit,
  type Settings,
  type SummaryVersion,
  type SessionProcessingSnapshot,
  type SessionProcessingPlan,
} from "./lib/api";
import { createNoteWriter } from "./lib/note-writer";
import { formatTimestamp } from "./lib/timestamps";
import { MeetingSidebar } from "./components/MeetingSidebar";
import {
  MeetingWorkspace,
  type Answer,
  type ContentTab,
} from "./components/MeetingWorkspace";
import { RecordingControls } from "./components/RecordingControls";
import { SetupPanel } from "./components/SetupPanel";
import {
  loadProcessing,
  saveProcessing,
  type ProcessingChoice,
} from "./lib/processing";
import { SessionReview } from "./components/SessionReview";
import { SettingsPanel, type SttDraft } from "./components/SettingsPanel";

type Writer = ReturnType<typeof createNoteWriter>;

export function App() {
  const desktop = api.isDesktop();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [controlBusy, setControlBusy] = useState(false);
  const controlBusyRef = useRef(false);
  const [error, setError] = useState("");
  const [notesError, setNotesError] = useState("");
  const noteFailure = useRef<unknown>(undefined);
  const [notice, setNotice] = useState("");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.matchMedia?.("(min-width: 801px)").matches ?? true,
  );
  const [tab, setTab] = useState<ContentTab>("notes");
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
    recording_offset_ms: null,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [autoProcessing, setAutoProcessing] =
    useState<ProcessingChoice>(loadProcessing);
  const chooseAutoProcessing = (choice: ProcessingChoice) => {
    saveProcessing(choice);
    setAutoProcessing(choice);
  };
  const [shortcut, setShortcut] = useState("");
  const [stopShortcut, setStopShortcut] = useState("");
  const [sttDraft, setSttDraft] = useState<SttDraft>({
    stt_language: "auto",
    stt_prompt: "",
    stt_model: "small",
  });
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [sttProgress, setSttProgress] = useState<SttDownloadProgress | null>(
    null,
  );
  const [transcribeProgress, setTranscribeProgress] = useState<
    Record<string, number>
  >({});
  const [job, setJob] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<Record<ProviderRole, KeyStatus>>({
    llm: "missing",
    cloud_stt: "missing",
  });
  const keyStatusVersion = useRef<Record<ProviderRole, number>>({
    llm: 0,
    cloud_stt: 0,
  });
  const updateKeyStatus = useCallback(
    (role: ProviderRole, status: KeyStatus) => {
      keyStatusVersion.current[role] += 1;
      setKeyStatus((previous) => ({ ...previous, [role]: status }));
    },
    [],
  );
  const sttStatusVersion = useRef(0);
  const updateStt = useCallback((status: SttStatus | null) => {
    sttStatusVersion.current += 1;
    setStt(status);
  }, []);
  const [title, setTitle] = useState("Untitled meeting");
  const [consent, setConsent] = useState(false);
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [microphone, setMicrophone] = useState("");
  const [output, setOutput] = useState("");
  const [health, setHealth] = useState<AudioHealth | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const [panel, setPanel] = useState<"setup" | "settings" | null>(null);
  const [settingsTab, setSettingsTab] = useState<"cloud" | "local" | "general">(
    "local",
  );
  const panelRef = useRef<HTMLElement | null>(null);
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectionRequest = useRef(0);
  const jobRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [audioBytes, setAudioBytes] = useState<number | null>(null);
  const [summaryVersions, setSummaryVersions] = useState<SummaryVersion[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [processing, setProcessing] =
    useState<SessionProcessingSnapshot | null>(null);
  const processingRevisions = useRef(new Map<string, number>());
  const [retryPlan, setRetryPlan] = useState<SessionProcessingPlan | null>(
    null,
  );
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [ackError, setAckError] = useState<{
    meetingId: string;
    message: string;
  } | null>(null);
  const ackAttempts = useRef(new Set<string>());

  const applyProcessing = useCallback((next: SessionProcessingSnapshot) => {
    const previous = processingRevisions.current.get(next.meeting_id);
    if (previous !== undefined && previous > next.revision) return false;
    processingRevisions.current.set(next.meeting_id, next.revision);
    if (selectedIdRef.current === next.meeting_id) setProcessing(next);
    return true;
  }, []);
  const acknowledgeNotes = useCallback(
    async (snapshot: SessionProcessingSnapshot, retry = false) => {
      const workflow = snapshot.workflow;
      if (
        snapshot.plan.scope.kind !== "final" ||
        snapshot.plan.scope.summary === null ||
        !workflow?.notes_barrier ||
        workflow.notes_revision !== null ||
        !["finalizing_audio", "transcribing", "awaiting_notes"].includes(
          workflow.stage,
        )
      )
        return;
      const key = `${workflow.run_id}:${workflow.notes_barrier}`;
      if (!retry && ackAttempts.current.has(key)) return;
      ackAttempts.current.add(key);
      try {
        const matchingWriter =
          selectedIdRef.current === snapshot.meeting_id ? writer.current : null;
        await matchingWriter?.flush();
        const revision = matchingWriter
          ? matchingWriter.persistedRevision()
          : (await api.getMeeting(snapshot.meeting_id)).notes_revision;
        applyProcessing(
          await api.acknowledgeProcessingNotes(
            snapshot.meeting_id,
            workflow.run_id,
            workflow.notes_barrier,
            revision,
          ),
        );
        setAckError((previous) =>
          previous?.meetingId === snapshot.meeting_id ? null : previous,
        );
      } catch (failure) {
        setAckError({
          meetingId: snapshot.meeting_id,
          message: errorMessage(failure),
        });
      }
    },
    [applyProcessing],
  );
  const refreshProcessing = useCallback(
    async (id: string) => {
      const snapshot = await api.getSessionProcessing(id);
      if (snapshot) {
        if (snapshot.meeting_id === id && applyProcessing(snapshot))
          await acknowledgeNotes(snapshot);
      } else if (
        selectedIdRef.current === id &&
        !processingRevisions.current.has(id)
      )
        setProcessing(null);
    },
    [applyProcessing, acknowledgeNotes],
  );

  const refreshList = useCallback(async () => {
    const request = ++listRequest.current;
    const list = await api.listMeetings();
    if (request === listRequest.current) setMeetings(list);
    // Disk usage is informational; failing to measure it must not block the list.
    void api.audioUsage().then(setAudioBytes, () => setAudioBytes(null));
    return list;
  }, []);

  const updateRecording = useCallback((next: RecordingState) => {
    setRecording((previous) =>
      next.revision >= previous.revision ? next : previous,
    );
  }, []);

  const openMeeting = useCallback(
    async (id: string) => {
      const request = ++selectionRequest.current;
      await writer.current?.flush();
      const detail = await api.getMeeting(id);
      if (request !== selectionRequest.current) return;
      detailRequest.current += 1;
      writer.current?.dispose();
      writer.current = createNoteWriter(
        detail.user_markdown,
        detail.notes_revision,
        (text, revision) => api.saveNotes(id, text, revision),
        (status, failure) => {
          setNotesStatus(status);
          noteFailure.current = failure;
          setNotesError(status === "error" ? errorMessage(failure) : "");
        },
      );
      setNotes(detail.user_markdown);
      setNotesStatus("saved");
      selectedIdRef.current = id;
      setSelected(detail);
      setProcessing(null);
      setRetryPlan(null);
      setRetryConfirmed(false);
      void refreshProcessing(id).catch((failure: unknown) =>
        setError(errorMessage(failure)),
      );
    },
    [refreshProcessing],
  );

  const refreshMeeting = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    const detail = await api.getMeeting(id);
    if (selectedIdRef.current === id && request === detailRequest.current)
      setSelected(detail);
  }, []);

  // One in-flight task per lock; `mark` mirrors the lock into render state.
  const guard = useCallback(
    async (
      lock: { current: boolean },
      mark: (on: boolean) => void,
      task: () => Promise<void>,
      keepMessages = false,
    ) => {
      if (lock.current) return;
      lock.current = true;
      mark(true);
      if (!keepMessages) {
        setError("");
        setNotice("");
      }
      try {
        await task();
      } catch (failure) {
        // Note-save failures are already shown by the notes banner.
        if (keepMessages || failure !== noteFailure.current)
          setError(errorMessage(failure));
      } finally {
        lock.current = false;
        mark(false);
      }
    },
    [],
  );
  const run = useCallback(
    (task: () => Promise<void>) => guard(busyRef, setBusy, task),
    [guard],
  );
  // Recording controls stay live while other tasks run, so they keep their own lock.
  const runControl = (task: () => Promise<void>) =>
    guard(controlBusyRef, setControlBusy, task, true);
  // Long local/remote jobs use their own flag so notes stay editable and recording controls stay live.
  const runJob = (kind: string, task: () => Promise<void>) =>
    guard(
      jobRef,
      (on) => {
        if (on && kind === "transcribe") setTranscribeProgress({});
        setJob(on ? kind : null);
      },
      task,
    );
  const finishJob = async (id: string) => {
    await refreshList();
    // Do not yank the user back if they moved to another meeting meanwhile.
    if (selectedIdRef.current === id) await refreshMeeting(id);
  };

  useEffect(() => {
    const id = recording.meeting_id;
    if (recording.status !== "stopped" || !id) return;
    void refreshMeeting(id).catch((failure: unknown) =>
      setError(errorMessage(failure)),
    );
    void refreshProcessing(id).catch((failure: unknown) =>
      setError(errorMessage(failure)),
    );
  }, [recording, refreshMeeting, refreshProcessing]);

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
        api.onSessionProcessingChanged((notification) => {
          void refreshProcessing(notification.meeting_id).catch(
            (failure: unknown) => setError(errorMessage(failure)),
          );
          if (selectedIdRef.current === notification.meeting_id)
            void refreshMeeting(notification.meeting_id).catch(
              (failure: unknown) => setError(errorMessage(failure)),
            );
        }),
      );
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
      await register(
        api.onSttProgress((progress) => {
          if (progress.stage === "transcribing")
            setTranscribeProgress((previous) => {
              const next = { ...previous, [progress.track]: progress.percent };
              if (progress.track !== "preparing") delete next.preparing;
              return next;
            });
          else setSttProgress(progress);
        }),
      );
      if (disposed) return;
      const [state, preferences] = await Promise.all([
        api.getRecordingState(),
        api.getSettings(),
      ]);
      if (disposed) return;
      updateRecording(state);
      setSettings(preferences);
      setShortcut(preferences.pause_shortcut);
      setStopShortcut(preferences.stop_shortcut ?? "");
      setSttDraft(preferences);
      const speechVersion = sttStatusVersion.current;
      // Device, credential, and engine discovery must not hold saved notes hostage.
      void Promise.all([
        api.getStartupWarning().then((warning) => {
          if (!disposed && warning) setError(warning);
        }),
        api.listDevices().then((discovered) => {
          if (disposed) return;
          setDevices(discovered);
          setMicrophone(
            preferences.microphone_id ?? discovered.microphones[0]?.id ?? "",
          );
          setOutput(preferences.output_id ?? discovered.outputs[0]?.id ?? "");
        }),
        ...(["llm", "cloud_stt"] satisfies ProviderRole[]).map((role) => {
          const version = keyStatusVersion.current[role];
          return api
            .providerKeyStatus(role)
            .catch(() => "unavailable" as const)
            .then((status) => {
              if (!disposed && version === keyStatusVersion.current[role])
                updateKeyStatus(role, status);
            });
        }),
        api
          .sttStatus()
          .catch(() => null)
          .then((speech) => {
            if (!disposed && speechVersion === sttStatusVersion.current)
              updateStt(speech);
          }),
      ]).catch((failure: unknown) => {
        if (!disposed) setError(errorMessage(failure));
      });
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
  }, [
    desktop,
    openMeeting,
    refreshList,
    updateRecording,
    updateKeyStatus,
    updateStt,
    refreshProcessing,
    refreshMeeting,
  ]);
  useEffect(() => {
    if (!desktop) return;
    const reconnect = () => {
      const id = selectedIdRef.current;
      if (id)
        void refreshProcessing(id).catch((failure: unknown) =>
          setError(errorMessage(failure)),
        );
      void api
        .getRecordingState()
        .then(updateRecording, (failure: unknown) =>
          setError(errorMessage(failure)),
        );
    };
    window.addEventListener("focus", reconnect);
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("online", reconnect);
    };
  }, [desktop, refreshProcessing, updateRecording]);

  useEffect(() => {
    if (job === null) {
      setSttProgress(null);
      setTranscribeProgress({});
    }
  }, [job]);
  // Summary history for the open meeting; reloaded whenever its detail reloads.
  useEffect(() => {
    const id = selected?.meeting.id;
    setSummaryVersions([]);
    if (!desktop || !id) return;
    let current = true;
    api.listSummaries(id).then(
      (list) => current && setSummaryVersions(list),
      (failure: unknown) => current && setError(errorMessage(failure)),
    );
    return () => {
      current = false;
    };
  }, [desktop, selected]);
  // Answers are never stored; leaving the meeting discards the shown one.
  const selectedId = selected?.meeting.id;
  useEffect(() => setAnswer(null), [selectedId]);
  useEffect(() => {
    setRetryPlan(null);
    setRetryConfirmed(false);
  }, [settings]);

  // Full-text matches for searches of 2+ characters; re-run when meetings change so hits stay current.
  useEffect(() => {
    const query = search.trim();
    if (!desktop || query.length < 2) {
      setHits([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.searchMeetings(query).then(
        (found) => {
          if (current) setHits(found);
        },
        (failure: unknown) => {
          if (current) setError(errorMessage(failure));
        },
      );
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [desktop, search, meetings]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (writer.current?.isDirty()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const active =
    recording.status === "recording" || recording.status === "paused";
  useEffect(() => setHealth(null), [recording.meeting_id, active]);
  const openPanel = (
    next: "setup" | "settings",
    trigger: HTMLButtonElement,
  ) => {
    panelTrigger.current = trigger;
    setPanel(next);
  };
  useEffect(() => {
    if (panel) {
      panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    } else {
      if (panelTrigger.current?.isConnected) panelTrigger.current.focus();
      panelTrigger.current = null;
    }
  }, [panel]);

  useEffect(() => {
    if (!panel || closeRequested) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPanel(null);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [panel, closeRequested]);
  const disabled = !ready || busy || controlBusy;
  const hasSummaryInput =
    notes.trim().length > 0 || (selected?.segments.length ?? 0) > 0;
  const enhanceBlocked = !selected
    ? "Select a meeting first."
    : keyStatus.llm !== "present" && !isLocalBase(settings?.llm?.base_url ?? "")
      ? "Save a summary API key in Settings first."
      : !settings?.llm?.model
        ? "Choose and save a summary model in Settings first."
        : !hasSummaryInput
          ? "Add notes or transcribe the audio first."
          : null;

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <MeetingSidebar
        open={sidebarOpen}
        meetings={meetings}
        search={search}
        selectedId={selected?.meeting.id}
        disabled={disabled}
        recordingActive={active}
        onSearch={setSearch}
        onNewRecording={(trigger) => {
          setConsent(false);
          openPanel("setup", trigger);
        }}
        onSettings={(trigger) => {
          setSettingsTab("local");
          openPanel("settings", trigger);
        }}
        onOpenMeeting={(id) =>
          void run(async () => {
            await openMeeting(id);
            setPanel(null);
          })
        }
        onNewNote={() =>
          void run(async () => {
            await writer.current?.flush();
            const id = await api.createNote("Untitled note");
            await refreshList();
            await openMeeting(id);
            setPanel(null);
            setTab("notes");
          })
        }
        hits={hits}
        onOpenHit={(hit) =>
          void run(async () => {
            await openMeeting(hit.meeting_id);
            setPanel(null);
            setTab(
              hit.kind === "transcript" || hit.kind === "summary"
                ? hit.kind
                : "notes",
            );
          })
        }
        audioBytes={audioBytes}
      />
      <main className="workspace">
        <header className="workspace-toolbar">
          <div className="toolbar-context">
            <button
              aria-label="Toggle meetings"
              aria-controls="meeting-sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                fill="none"
                aria-hidden="true"
              >
                <rect x="2.5" y="3" width="15" height="14" rx="2" />
                <path d="M7.5 3v14" />
              </svg>
              <span>Meetings</span>
            </button>
            <span className="toolbar-location">
              {panel === "settings"
                ? "Preferences"
                : panel === "setup"
                  ? "New recording"
                  : "Workspace"}
            </span>
          </div>
          <details className="privacy-details">
            <summary>
              <span className="status-dot" aria-hidden="true" /> Local workspace{" "}
              <span className="preview-tag">Preview</span>
            </summary>
            <div className="privacy-popover">
              <strong>Your workspace is stored on this device.</strong>
              <p>
                Recording saves microphone and system audio locally. Local
                transcription stays on this computer. Cloud transcription
                uploads audio, and summaries and questions send text to your
                selected provider only after you confirm.
              </p>
              <p>
                Capture is not yet hardware-qualified. Local files are
                unencrypted.
              </p>
            </div>
          </details>
        </header>
        <div className="feedback-stack">
          {!desktop && (
            <p role="alert">
              Open this app with <code>corepack pnpm tauri dev</code>. The
              browser preview cannot access the desktop database.
            </p>
          )}
          {error && (
            <div className="error" role="alert">
              {error} <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {notesError && (
            <p className="error" role="alert">
              Notes not saved: {notesError}. Keep or copy your edits before
              quitting.
            </p>
          )}
          {recording.error && (
            <p className="error" role="alert">
              Capture: {recording.error}
            </p>
          )}
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                Dismiss
              </button>
            </div>
          )}
          {desktop && !ready && !error && (
            <p role="status">Opening local database…</p>
          )}
          {active && health?.tracks.some((track) => track.gaps > 0) && (
            <p className="notice" role="status">
              Audio gaps detected (
              {health.tracks
                .filter((track) => track.gaps > 0)
                .map((track) => `${track.kind}: ${track.gaps}`)
                .join(", ")}
              ). Recording continues; exact positions are kept in the timing
              index.
            </p>
          )}
          {active && health?.error && (
            <p className="error" role="alert">
              Audio: {health.error}
            </p>
          )}
          {panel === null &&
            processing &&
            processing.meeting_id === selected?.meeting.id && (
              <section
                className="processing-panel"
                aria-label="Session processing"
              >
                <h3>Automatic processing</h3>
                <p role="status">
                  Stage:{" "}
                  {(processing.workflow?.stage ?? processing.state).replaceAll(
                    "_",
                    " ",
                  )}
                </p>
                {processing.workflow?.error && (
                  <p role="alert">{processing.workflow.error}</p>
                )}
                {processing.workflow?.live_incomplete && (
                  <p role="status">
                    Live transcript is incomplete. Recorded audio is preserved
                    for final transcription.
                  </p>
                )}
                {processing.workflow && (
                  <p>
                    Used {processing.workflow.requests_used} requests,{" "}
                    {processing.workflow.upload_bytes_used} audio bytes and{" "}
                    {processing.workflow.text_bytes_used} UTF-8 text bytes.
                  </p>
                )}
                {processing.plan.scope.kind === "final" &&
                  processing.plan.scope.summary !== null &&
                  processing.workflow?.notes_barrier &&
                  processing.workflow.notes_revision === null &&
                  [
                    "finalizing_audio",
                    "transcribing",
                    "awaiting_notes",
                  ].includes(processing.workflow.stage) && (
                    <div>
                      <p>
                        Automatic summary waits for saved notes.
                        {ackError?.meetingId === processing.meeting_id &&
                          ` Notes acknowledgement failed: ${ackError.message}`}
                      </p>
                      <button
                        disabled={busy}
                        onClick={() => void acknowledgeNotes(processing, true)}
                      >
                        Save notes and continue processing
                      </button>
                    </div>
                  )}
                {![
                  "completed",
                  "cancelled",
                  "interrupted",
                  "failed",
                  "consent_required",
                ].includes(processing.workflow?.stage ?? processing.state) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        applyProcessing(
                          await api.cancelSessionProcessing(
                            processing.meeting_id,
                            processing.revision,
                          ),
                        );
                      })
                    }
                  >
                    Cancel session processing
                  </button>
                )}
                {[
                  "failed",
                  "cancelled",
                  "interrupted",
                  "consent_required",
                ].includes(processing.workflow?.stage ?? processing.state) && (
                  <button
                    disabled={busy || active}
                    onClick={() =>
                      void run(async () => {
                        setRetryConfirmed(false);
                        setRetryPlan(
                          await api.prepareSessionRetry(processing.meeting_id),
                        );
                      })
                    }
                  >
                    Review processing retry
                  </button>
                )}
                {retryPlan?.meeting_id === processing.meeting_id && (
                  <>
                    <SessionReview
                      plan={retryPlan}
                      confirmed={retryConfirmed}
                      onConfirm={setRetryConfirmed}
                    />
                    <button
                      disabled={
                        busy ||
                        !retryConfirmed ||
                        retryPlan.review_expires_at <= Date.now() / 1000
                      }
                      onClick={() =>
                        void run(async () => {
                          applyProcessing(
                            await api.retrySessionProcessing(
                              processing.meeting_id,
                              retryPlan.fingerprint,
                            ),
                          );
                          setRetryPlan(null);
                          await refreshProcessing(processing.meeting_id);
                        })
                      }
                    >
                      Confirm processing retry
                    </button>
                  </>
                )}
                {!!processing.workflow?.provisional.length && (
                  <section aria-label="Provisional live transcript">
                    <h4>Provisional live transcript</h4>
                    <p>
                      Latest 200 segments. Excluded from search, export and
                      summaries until final transcription.
                    </p>
                    {Array.from(
                      new Map(
                        processing.workflow.provisional.map((row) => [
                          row.id,
                          row,
                        ]),
                      ).values(),
                    )
                      .slice(-200)
                      .map((row) => (
                        <p key={row.id}>
                          {row.segment.timing.kind === "timed"
                            ? `${formatTimestamp(row.segment.timing.start_ms)} `
                            : "[Untimed] "}
                          <strong>{row.segment.speaker}:</strong>{" "}
                          <span>{row.segment.text}</span>
                        </p>
                      ))}
                  </section>
                )}
              </section>
            )}
        </div>

        {panel === "setup" && (
          <SetupPanel
            panelRef={panelRef}
            devices={devices}
            title={title}
            consent={consent}
            microphone={microphone}
            output={output}
            disabled={disabled}
            active={active}
            configurationRevision={JSON.stringify(settings)}
            processing={autoProcessing}
            onOpenSettings={() => {
              setSettingsTab("general");
              setPanel("settings");
            }}
            onTitle={setTitle}
            onConsent={setConsent}
            onMicrophone={setMicrophone}
            onOutput={setOutput}
            onClose={() => setPanel(null)}
            onStartCapture={(confirmation) =>
              void run(async () => {
                await writer.current?.flush();
                const state = await api.startCapture(
                  title,
                  consent,
                  {
                    microphoneId: microphone,
                    outputId: output,
                  },
                  confirmation,
                );
                updateRecording(state);
                setPanel(null);
                if (state.meeting_id) await openMeeting(state.meeting_id);
                await refreshList();
              })
            }
          />
        )}
        <MeetingWorkspace
          hidden={panel !== null}
          selected={selected}
          firstRun={ready && meetings.length === 0}
          job={job}
          speechReady={
            settings?.stt_mode === "cloud"
              ? (keyStatus.cloud_stt === "present" ||
                  isLocalBase(settings.cloud_stt?.base_url ?? "")) &&
                !!settings.cloud_stt?.model
              : stt?.installed === true
          }
          sttMode={settings?.stt_mode ?? "local"}
          connectionRevision={`${settings?.llm?.revision ?? 0}:${settings?.cloud_stt?.revision ?? 0}`}
          enhanceBlocked={enhanceBlocked}
          onPlanTranscription={async () => {
            const id = selected?.meeting.id;
            let plan: ProcessingPlan | null = null;
            if (!id) return plan;
            await run(async () => {
              await writer.current?.flush();
              plan = await api.planTranscription(id);
            });
            return plan;
          }}
          onTranscribe={(confirmation) => {
            const id = selected?.meeting.id;
            if (!id) return;
            void runJob("transcribe", async () => {
              await writer.current?.flush();
              try {
                await api.transcribeMeeting(id, confirmation);
              } catch (failure) {
                const code = (failure as { code?: string } | null)?.code;
                if (code !== "stt_cancelled") throw failure;
                setNotice(errorMessage(failure));
                return;
              }
              await finishJob(id);
              setNotice("Transcript generated and saved.");
            });
          }}
          live={
            active &&
            recording.source === "desktop" &&
            recording.meeting_id === selected?.meeting.id
          }
          transcribeProgress={transcribeProgress}
          onCancelTranscribe={() =>
            void api
              .cancelTranscription()
              .then((accepted) =>
                setNotice(
                  accepted
                    ? "Cancellation requested. Audio already uploaded cannot be recalled."
                    : "Transcription has not started or has already finished.",
                ),
              )
              .catch((failure: unknown) => setError(errorMessage(failure)))
          }
          getRecordingOffset={async () => {
            try {
              const state = await api.getRecordingState();
              updateRecording(state);
              return state.recording_offset_ms;
            } catch (failure) {
              setError(errorMessage(failure));
              return null;
            }
          }}
          onSeek={async (kind, sessionMs) => {
            const id = selected?.meeting.id;
            if (!id) return null;
            try {
              return await api.audioPosition(id, kind, sessionMs);
            } catch (failure) {
              setError(errorMessage(failure));
              return null;
            }
          }}
          onGenerate={(template, confirmation) => {
            const id = selected?.meeting.id;
            if (!id) return;
            void runJob("summary", async () => {
              await writer.current?.flush();
              await api.generateSummary(id, template, confirmation);
              await finishJob(id);
              setNotice(
                "Summary generated and saved. Only notes and transcript text were sent to your selected provider.",
              );
            });
          }}
          versions={summaryVersions}
          onPlanSummary={async (template) => {
            const id = selected?.meeting.id;
            let plan: ProcessingPlan | null = null;
            if (!id) return plan;
            await run(async () => {
              await writer.current?.flush();
              plan = await api.planSummary(id, template);
            });
            return plan;
          }}
          answer={answer}
          onPlanQuestion={async (question) => {
            const id = selected?.meeting.id;
            let plan: ProcessingPlan | null = null;
            if (!id) return plan;
            await run(async () => {
              await writer.current?.flush();
              plan = await api.planQuestion(id, question);
            });
            return plan;
          }}
          onAsk={(question, confirmation) => {
            const id = selected?.meeting.id;
            if (!id) return;
            void runJob("ask", async () => {
              await writer.current?.flush();
              const text = await api.askMeeting(id, question, confirmation);
              if (selectedIdRef.current === id)
                setAnswer({ meetingId: id, question, text });
            });
          }}
          notes={notes}
          notesStatus={notesStatus}
          tab={tab}
          disabled={disabled}
          onTab={setTab}
          onNotes={(text) => {
            setNotes(text);
            writer.current?.update(text);
          }}
          onSaveNow={() =>
            void run(async () => {
              await writer.current?.flush();
            })
          }
          onExport={() =>
            void run(async () => {
              await writer.current?.flush();
              if (!selected) return;
              if (!settings?.vault_folder) {
                const updated = await api.chooseVaultFolder();
                setSettings(updated);
                if (!updated.vault_folder) return;
              }
              const result = await api.exportMeeting(selected.meeting.id);
              setNotice(
                `${result.created_copy ? "Existing file preserved; created a new snapshot" : "Exported"}: ${result.path}`,
              );
            })
          }
          recordingThis={
            active && recording.meeting_id === selected?.meeting.id
          }
          onDeleteMeeting={() => {
            const id = selected?.meeting.id;
            if (!id) return;
            void run(async () => {
              // The notes are being deleted; a failed final save must not block that.
              await writer.current?.flush().catch(() => {});
              await api.deleteMeeting(id);
              writer.current?.dispose();
              writer.current = null;
              selectedIdRef.current = null;
              setSelected(null);
              setNotes("");
              setNotesStatus("saved");
              setNotesError("");
              const list = await refreshList();
              if (list[0]) await openMeeting(list[0].id);
              setNotice(
                "Meeting deleted from this device. Exported Markdown snapshots were not touched.",
              );
            });
          }}
          onDeleteAudio={() => {
            const id = selected?.meeting.id;
            if (!id) return;
            void run(async () => {
              await writer.current?.flush();
              await api.deleteAudio(id);
              await refreshList();
              await openMeeting(id);
              setNotice(
                "Audio deleted. Notes, transcript and summaries were kept.",
              );
            });
          }}
          onRename={(next) => {
            const id = selected?.meeting.id;
            if (!id) return;
            void run(async () => {
              const stored = await api.renameMeeting(id, next);
              // The sidebar refreshes from the backend's meeting_updated event.
              setSelected((current) =>
                current?.meeting.id === id
                  ? {
                      ...current,
                      meeting: { ...current.meeting, title: stored },
                    }
                  : current,
              );
            });
          }}
          onRecover={() => {
            const id = selected?.meeting.id;
            if (!id) return;
            void runJob("recover", async () => {
              await writer.current?.flush();
              await api.recoverAudio(id);
              await finishJob(id);
              setNotice(
                "Recovered audio saved as new copies. The original files were left unchanged.",
              );
            });
          }}
        />

        {panel === "settings" && (
          <SettingsPanel
            panelRef={panelRef}
            initialTab={settingsTab}
            processing={autoProcessing}
            onProcessing={chooseAutoProcessing}
            settings={settings}
            disabled={disabled}
            shortcut={shortcut}
            keyStatus={keyStatus}
            onKeyStatus={updateKeyStatus}
            onSettings={setSettings}
            onImported={async () => updateStt(await api.sttStatus())}
            onSttMode={(mode) =>
              void run(async () => setSettings(await api.saveSttMode(mode)))
            }
            stt={stt}
            sttProgress={sttProgress}
            installing={job === "install"}
            onCancelStt={() =>
              void api
                .cancelModelDownload()
                .catch((failure: unknown) => setError(errorMessage(failure)))
            }
            onInstallStt={() =>
              void runJob("install", async () => {
                updateStt(await api.sttInstall());
                setNotice("Speech engine and models downloaded and verified.");
              })
            }
            onShortcut={setShortcut}
            onClose={() => setPanel(null)}
            onChooseFolder={() =>
              void run(async () => {
                setSettings(await api.chooseVaultFolder());
              })
            }
            onSaveShortcut={() =>
              void run(async () => {
                const updated = await api.saveSettings(
                  shortcut,
                  stopShortcut.trim() || null,
                );
                setSettings(updated);
                setShortcut(updated.pause_shortcut);
                setStopShortcut(updated.stop_shortcut ?? "");
                setNotice("Shortcuts saved.");
              })
            }
            stopShortcut={stopShortcut}
            onStopShortcut={setStopShortcut}
            sttDraft={sttDraft}
            onStt={(change) =>
              setSttDraft((draft) => ({ ...draft, ...change }))
            }
            onSaveStt={() =>
              void run(async () => {
                const updated = await api.saveSttSettings(
                  sttDraft.stt_language,
                  sttDraft.stt_prompt,
                  sttDraft.stt_model,
                );
                setSettings(updated);
                setSttDraft(updated);
                updateStt(await api.sttStatus());
                setNotice("Transcription settings saved.");
              })
            }
            onExportOptions={(options) =>
              void run(async () => {
                setSettings(await api.saveExportOptions(options));
              })
            }
          />
        )}
        <RecordingControls
          recording={recording}
          active={active}
          ready={ready}
          controlBusy={controlBusy}
          disabled={disabled}
          showOpenActive={
            active &&
            !!recording.meeting_id &&
            recording.meeting_id !== selected?.meeting.id
          }
          onOpenActive={() =>
            void run(() => openMeeting(recording.meeting_id!))
          }
          onToggle={() =>
            void runControl(async () => {
              updateRecording(
                await (recording.status === "paused"
                  ? api.resume()
                  : api.pause()),
              );
            })
          }
          onStop={() =>
            void runControl(async () => {
              updateRecording(await api.stop());
              // Stopping is independent of saving; failed drafts remain in the writer.
              await Promise.all([
                refreshList(),
                recording.meeting_id
                  ? refreshProcessing(recording.meeting_id)
                  : Promise.resolve(),
              ]);
            })
          }
          health={health}
        />
        {closeRequested && (
          <section
            className="close-panel"
            role="dialog"
            aria-modal="false"
            aria-labelledby="close-title"
          >
            <h2 id="close-title">Save and quit?</h2>
            <p>
              Your notes will be saved first. Any active recording will stop.
              Background processing will be cancelled.
            </p>
            <button
              autoFocus
              disabled={busy || controlBusy}
              onClick={() =>
                void run(async () => {
                  await writer.current?.flush();
                  await api.close();
                })
              }
            >
              Save and quit
            </button>
            <button
              disabled={busy || controlBusy}
              onClick={() => setCloseRequested(false)}
            >
              Keep working
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
