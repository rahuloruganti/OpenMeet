import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import {
  api,
  errorCode,
  errorMessage,
  isLocalBase,
  type AudioHealth,
  type KeyStatus,
  type Meeting,
  type MeetingDetail,
  type MicApp,
  type ProviderRole,
  type RecordingState,
  type SearchHit,
  type SessionProcessingSnapshot,
  type Settings,
  type SummaryVersion,
} from "../../../shared/api/api";
import { createNoteWriter } from "../../../features/note-writer";
import { LibraryQuestion } from "../../../widgets/library-question";
import type {
  ContentTab,
  SegmentDraft,
  SummaryDraft,
} from "../../../widgets/meeting-workspace";
import type { OpenSettings } from "../../../shared/ui/settings-link";
import type { Panel, MeetingPageProps } from "../ui/MeetingPage";
import { awaitingNotes } from "./processing";

type Writer = ReturnType<typeof createNoteWriter>;

/** Names for capture tracks in the audio-gap notice. */
const gapTrackLabels: Record<string, string> = {
  mic: "Microphone",
  system: "System audio",
};

const narrowWindowQuery = "(max-width: 800px)";

/** What the meeting view needs from the app shell, which outlives it. */
export type MeetingPageEnv = {
  desktop: boolean;
  ready: boolean;
  disabled: boolean;
  busy: boolean;
  controlBusy: boolean;
  firstRun: boolean;
  settings: Settings | null;
  setSettings: (settings: Settings) => void;
  notice: string;
  setNotice: (notice: string) => void;
  error: string;
  setError: (error: string) => void;
  report: (failure: unknown) => void;
  run: (task: () => Promise<void>) => void;
  runControl: (task: () => Promise<void>) => void;
  runJob: (kind: string, task: () => Promise<void>) => void;
  keyStatus: Record<ProviderRole, KeyStatus>;
  recording: RecordingState;
  updateRecording: (next: RecordingState) => void;
  active: boolean;
  health: AudioHealth | null;
  panel: Panel;
  openPanel: (next: Exclude<Panel, null>, trigger: HTMLButtonElement) => void;
  closePanel: () => void;
  /** Ask across meetings: the full page (or the library panel in the preview). */
  openAsk: (trigger: HTMLButtonElement) => void;
  openSettings: OpenSettings;
  panelRef: RefObject<HTMLElement | null>;
  workspaceRef: RefObject<HTMLElement | null>;
  focusWorkspace: () => void;
  title: string;
  setTitle: (title: string) => void;
  detectedApp: MicApp | undefined;
  dismissDetectedApp: (id: string) => void;
  speechReady: boolean;
  audioBytes: number | null;
  setAudioBytes: (bytes: number | null) => void;
  job: string | null;
  transcribeProgress: Record<string, number>;
  closeRequested: boolean;
  setCloseRequested: (value: boolean) => void;
  noteFailure: RefObject<unknown>;
};

/**
 * Meeting view: the meeting list and search, the open meeting's notes and drafts,
 * its processing state, and every handler the sidebar and workspace call.
 */
export function useMeetingPage(env: MeetingPageEnv) {
  const {
    desktop,
    ready,
    disabled,
    settings,
    setSettings,
    setNotice,
    setError,
    report,
    run,
    runControl,
    runJob,
    keyStatus,
    recording,
    updateRecording,
    active,
    health,
    panel,
    openPanel,
    closePanel,
    openSettings,
    transcribeProgress,
    audioBytes,
    setAudioBytes,
  } = env;
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.matchMedia?.("(min-width: 801px)").matches ?? true,
  );
  // Narrowing to this width collapses navigation; widening again leaves it as the user set it.
  useEffect(() => {
    const media = window.matchMedia?.(narrowWindowQuery);
    const collapse = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    media?.addEventListener?.("change", collapse);
    return () => media?.removeEventListener?.("change", collapse);
  }, []);
  const [tab, setTab] = useState<ContentTab>("notes");
  const [selected, setSelected] = useState<MeetingDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [notesStatus, setNotesStatus] = useState("saved");
  const writer = useRef<Writer | null>(null);
  const [notesError, setNotesError] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [summaryVersions, setSummaryVersions] = useState<SummaryVersion[]>([]);
  const [processing, setProcessing] =
    useState<SessionProcessingSnapshot | null>(null);
  const processingRevisions = useRef(new Map<string, number>());
  const [ackError, setAckError] = useState<{
    meetingId: string;
    message: string;
  } | null>(null);
  const ackAttempts = useRef(new Set<string>());
  const [dismissedCapture, setDismissedCapture] = useState("");
  const [dismissedGaps, setDismissedGaps] = useState("");
  // Revision of each meeting's processing state that was dismissed; a new revision shows again.
  const [dismissedProcessing, setDismissedProcessing] = useState<
    Record<string, number>
  >({});
  // Unsaved summary edits per meeting; quitting warns before discarding them.
  const [summaryDrafts, setSummaryDrafts] = useState<
    Record<string, SummaryDraft>
  >({});
  const [segmentDraft, setSegmentDraft] = useState<SegmentDraft | null>(null);
  // A library-answer citation waiting for its meeting to be shown.
  const [pendingJump, setPendingJump] = useState<{
    meetingId: string;
    ms: number | null;
  } | null>(null);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectionRequest = useRef(0);
  const selectedIdRef = useRef<string | null>(null);

  const unsavedEdits =
    Object.keys(summaryDrafts).length > 0 || segmentDraft !== null;
  const setSummaryDraft = (id: string, draft: SummaryDraft | null) =>
    setSummaryDrafts((drafts) => {
      const next = { ...drafts };
      if (draft) next[id] = draft;
      else delete next[id];
      return next;
    });

  const applyProcessing = useCallback((next: SessionProcessingSnapshot) => {
    const previous = processingRevisions.current.get(next.meeting_id);
    if (previous !== undefined && previous > next.revision) return false;
    processingRevisions.current.set(next.meeting_id, next.revision);
    if (selectedIdRef.current === next.meeting_id) setProcessing(next);
    return true;
  }, []);
  const acknowledgeNotes = useCallback(
    async (snapshot: SessionProcessingSnapshot, retry = false) => {
      if (!awaitingNotes(snapshot)) return;
      const workflow = snapshot.workflow!;
      const barrier = workflow.notes_barrier!;
      const key = `${workflow.run_id}:${barrier}`;
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
            barrier,
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
          env.noteFailure.current = failure;
          setNotesError(status === "error" ? errorMessage(failure) : "");
        },
      );
      setNotes(detail.user_markdown);
      setNotesStatus("saved");
      selectedIdRef.current = id;
      setSelected(detail);
      // A note has no transcript, so it opens on My notes instead of an empty Transcript tab.
      if (detail.meeting.source === "note")
        setTab((current) => (current === "transcript" ? "notes" : current));
      setProcessing(null);
      void refreshProcessing(id).catch(report);
    },
    [refreshProcessing],
  );

  const refreshMeeting = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    const detail = await api.getMeeting(id);
    if (selectedIdRef.current === id && request === detailRequest.current)
      setSelected(detail);
    return detail;
  }, []);

  /** Refreshes the open meeting's detail when a notification is about it. */
  const refreshSelected = useCallback(
    async (id: string) =>
      selectedIdRef.current === id ? refreshMeeting(id) : null,
    [refreshMeeting],
  );
  /** The open meeting's id, for listeners that outlive a render. */
  const selectedMeetingId = useCallback(() => selectedIdRef.current, []);

  // Replaces only the patched fields, so an unsaved notes draft is untouched.
  const patchSelected = (
    id: string,
    patch: (current: MeetingDetail) => Partial<MeetingDetail>,
  ) =>
    setSelected((current) =>
      current?.meeting.id === id ? { ...current, ...patch(current) } : current,
    );
  const finishJob = async (id: string) => {
    await refreshList();
    // Do not yank the user back if they moved to another meeting meanwhile.
    return selectedIdRef.current === id ? refreshMeeting(id) : null;
  };

  useEffect(() => {
    const id = recording.meeting_id;
    if (recording.status !== "stopped" || !id) return;
    void refreshMeeting(id).catch(report);
    void refreshProcessing(id).catch(report);
  }, [recording, refreshMeeting, refreshProcessing]);

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

  const hasSummaryInput =
    // A regex stops at the first non-space character instead of copying the whole note.
    /\S/.test(notes) || (selected?.segments.length ?? 0) > 0;
  // Why the summary/question provider cannot be used; rewrites need nothing more.
  const llmBlocked = !settings?.llm
    ? {
        message:
          "AI notes aren't set up. Choose a connection in Settings → AI notes.",
        section: "ai" as const,
      }
    : !isLocalBase(settings.llm.base_url) && keyStatus.llm !== "present"
      ? {
          message: "Add the AI notes API key in Settings → AI notes.",
          section: "ai" as const,
        }
      : !settings.llm.model
        ? {
            message: "Choose a model for AI notes in Settings → AI notes.",
            section: "ai" as const,
          }
        : null;
  // The banner adds its own period, so drop the one the error message may already end with.
  const notesErrorReason = notesError.replace(/\.$/, "");
  const captureKey = `${recording.meeting_id}:${recording.error}`;
  const gapped = active
    ? (health?.tracks.filter((track) => track.gaps > 0) ?? [])
    : [];
  const gapCounts = gapped
    .map(
      (track) => `${gapTrackLabels[track.kind] ?? track.kind}: ${track.gaps}`,
    )
    .join(", ");
  const gapNotice =
    gapped.length > 0
      ? `Audio gaps detected (${gapCounts}). Recording continues; exact positions are kept in the timing index.`
      : "";
  const gapKey = `${recording.meeting_id}:${gapNotice}`;
  const enhanceBlocked = !selected
    ? "Select a meeting first."
    : (llmBlocked?.message ??
      (!hasSummaryInput ? "Add notes or transcribe the audio first." : null));
  // On narrow windows the opened content should be visible, so navigation closes.
  const collapseIfNarrow = () => {
    if (window.matchMedia?.(narrowWindowQuery).matches) setSidebarOpen(false);
  };
  // The inspector's open state lives in settings, so it survives a restart.
  const inspectorOpen = settings?.inspector_open;
  const toggleInspector = () => {
    if (!settings) return;
    void api
      .saveUiPrefs(settings.theme ?? "system", !settings.inspector_open)
      .then(setSettings, report);
  };
  // With meetings but nothing open, the most recent one opens; startup is App's own call.
  useEffect(() => {
    if (!ready || selected || meetings.length === 0) return;
    void openMeeting(meetings[0].id).catch(report);
  }, [ready, selected, meetings, openMeeting, report]);
  const newNote = () =>
    void run(async () => {
      await writer.current?.flush();
      const id = await api.createNote("Untitled note");
      await refreshList();
      await openMeeting(id);
      closePanel();
      setTab("notes");
      collapseIfNarrow();
    });
  const dismissDetectedApp = env.dismissDetectedApp;
  const setupDetected = (trigger: HTMLButtonElement) => {
    if (!env.detectedApp) return;
    dismissDetectedApp(env.detectedApp.id);
    if (env.title === "Untitled meeting")
      env.setTitle(`${env.detectedApp.name} meeting`);
    openPanel("setup", trigger);
  };
  const dismissDetected = () => {
    if (!env.detectedApp) return;
    env.focusWorkspace();
    dismissDetectedApp(env.detectedApp.id);
  };
  const ignoreDetected = () => {
    const app = env.detectedApp;
    if (!app) return;
    env.focusWorkspace();
    dismissDetectedApp(app.id);
    void run(async () =>
      setSettings(await api.setDetectionIgnored(app.id, app.name, true)),
    );
  };
  const acknowledge = (retry: boolean) => {
    if (processing) void acknowledgeNotes(processing, retry);
  };

  /** Ask across meetings is a full page now; the shell renders it from these props. */
  const ask: ComponentProps<typeof LibraryQuestion> = {
    panelRef: panel === "library" ? env.panelRef : null,
    meetings,
    recipes: settings?.recipes ?? [],
    connectionRevision: `${settings?.llm?.revision ?? 0}`,
    llmBlocked,
    onOpenSettings: openSettings,
    disabled,
    onClose: closePanel,
    onOpen: (id, ms) =>
      void run(async () => {
        await openMeeting(id);
        if (selectedIdRef.current !== id) return;
        closePanel();
        setPendingJump({ meetingId: id, ms });
      }),
  };

  const pageProps: MeetingPageProps = {
    sidebarOpen,
    panel,
    workspaceRef: env.workspaceRef,
    onToggleSidebar: () => setSidebarOpen((open) => !open),
    onNewRecording: (trigger) => openPanel("setup", trigger),
    onNewNote: newNote,
    onOpenSettings: (trigger) => openSettings("transcription", trigger),
    sidebar: {
      open: sidebarOpen,
      meetings,
      search,
      selectedId: selected?.meeting.id,
      disabled,
      recordingActive: active,
      onSearch: setSearch,
      onNewRecording: (trigger) => openPanel("setup", trigger),
      onSettings: (trigger) => openSettings("transcription", trigger),
      onAsk: env.openAsk,
      onOpenMeeting: (id) =>
        void run(async () => {
          await openMeeting(id);
          closePanel();
          collapseIfNarrow();
        }),
      onNewNote: newNote,
      hits,
      onOpenHit: (hit) =>
        void run(async () => {
          await openMeeting(hit.meeting_id);
          closePanel();
          setTab(
            hit.kind === "transcript" || hit.kind === "summary"
              ? hit.kind
              : "notes",
          );
          collapseIfNarrow();
        }),
      audioBytes,
    },
    feedback: {
      desktop,
      ready,
      busy: env.busy,
      active,
      disabled,
      detectedApp: env.detectedApp,
      notesError,
      notesErrorReason,
      error: env.error,
      captureError:
        recording.error && captureKey !== dismissedCapture
          ? recording.error
          : null,
      processingNotice:
        recording.processing_notice &&
        recording.meeting_id === selected?.meeting.id
          ? recording.processing_notice
          : null,
      notice: env.notice,
      gapNotice: gapKey !== dismissedGaps ? gapNotice : "",
      healthError: active ? (health?.error ?? null) : null,
      processing:
        panel === null &&
        processing &&
        processing.meeting_id === selected?.meeting.id &&
        dismissedProcessing[processing.meeting_id] !== processing.revision
          ? processing
          : null,
      ackError,
      onSetupDetected: setupDetected,
      onDismissDetected: dismissDetected,
      onIgnoreDetected: ignoreDetected,
      onDismissError: () => {
        env.focusWorkspace();
        setError("");
      },
      onDismissCapture: () => {
        env.focusWorkspace();
        setDismissedCapture(captureKey);
      },
      onDismissNotice: () => {
        env.focusWorkspace();
        setNotice("");
      },
      onDismissGaps: () => {
        env.focusWorkspace();
        setDismissedGaps(gapKey);
      },
      onAcknowledgeNotes: acknowledge,
      onCancelProcessing: () => {
        if (!processing) return;
        void run(async () => {
          applyProcessing(
            await api.cancelSessionProcessing(
              processing.meeting_id,
              processing.revision,
            ),
          );
        });
      },
      onRetryProcessing: () => {
        if (!processing) return;
        void run(async () => {
          applyProcessing(
            await api.retrySessionProcessing(processing.meeting_id),
          );
          await refreshProcessing(processing.meeting_id);
        });
      },
      onDismissProcessing: () => {
        if (!processing) return;
        env.focusWorkspace();
        setDismissedProcessing((dismissed) => ({
          ...dismissed,
          [processing.meeting_id]: processing.revision,
        }));
      },
    },
    workspace: {
      pendingJump,
      onJumpDone: () => setPendingJump(null),
      hidden: panel === "settings" || panel === "library" || env.firstRun,
      selected,
      firstRun: ready && meetings.length === 0,
      onStartRecording: (trigger) => openPanel("setup", trigger),
      onNewNote: newNote,
      inspectorOpen,
      onToggleInspector: toggleInspector,
      job: env.job,
      processing:
        processing &&
        dismissedProcessing[processing.meeting_id] !== processing.revision
          ? processing
          : null,
      speechReady: env.speechReady,
      sttMode: settings?.stt_mode ?? "local",
      enhanceBlocked,
      llmBlocked,
      onOpenSettings: openSettings,
      onTranscribe: () => {
        const id = selected?.meeting.id;
        if (!id) return;
        void runJob("transcribe", async () => {
          await writer.current?.flush();
          try {
            await api.transcribeMeeting(id);
          } catch (failure) {
            if (errorCode(failure) !== "stt_cancelled") throw failure;
            setNotice(errorMessage(failure));
            return;
          }
          const detail = await finishJob(id);
          setNotice(
            detail?.segments.length === 0
              ? "No speech was found in the recording. Check the microphone level, then transcribe again."
              : "Transcript generated and saved.",
          );
        });
      },
      live:
        active &&
        recording.source === "desktop" &&
        recording.meeting_id === selected?.meeting.id,
      transcribeProgress,
      onCancelTranscribe: () =>
        void api
          .cancelTranscription()
          .then((accepted) =>
            setNotice(
              accepted
                ? "Cancellation requested. Audio already uploaded cannot be recalled."
                : "Transcription has not started or has already finished.",
            ),
          )
          .catch(report),
      getRecordingOffset: async () => {
        try {
          const state = await api.getRecordingState();
          updateRecording(state);
          return state.recording_offset_ms;
        } catch (failure) {
          report(failure);
          return null;
        }
      },
      onSeek: async (kind, sessionMs) => {
        const id = selected?.meeting.id;
        if (!id) return null;
        try {
          return await api.audioPosition(id, kind, sessionMs);
        } catch (failure) {
          report(failure);
          return null;
        }
      },
      onGenerate: (template) => {
        const id = selected?.meeting.id;
        if (!id) return;
        void runJob("summary", async () => {
          await writer.current?.flush();
          await api.generateSummary(id, template);
          await finishJob(id);
          setNotice(
            "Summary saved. Only notes and transcript text were sent to your connection.",
          );
        });
      },
      versions: summaryVersions,
      customTemplates: settings?.summary_templates ?? [],
      defaultTemplate: settings?.summary_default ?? "general-v1",
      recipes: settings?.recipes ?? [],
      summaryDraft: selected ? summaryDrafts[selected.meeting.id] : undefined,
      onSummaryDraft: (draft) => {
        if (selected) setSummaryDraft(selected.meeting.id, draft);
      },
      onSaveSummaryEdit: async (draft) => {
        const id = selected?.meeting.id;
        let saved = false;
        if (!id) return saved;
        await run(async () => {
          try {
            await api.saveSummaryEdit(
              id,
              draft.baseId,
              draft.latestId,
              draft.text,
            );
          } catch (failure) {
            // Rebase onto the newer version so saving again is the user's explicit choice.
            if (errorCode(failure) === "summary_conflict") {
              const newest = (await api.listSummaries(id))[0];
              if (newest)
                setSummaryDraft(id, { ...draft, latestId: newest.id });
              await finishJob(id);
            }
            throw failure;
          }
          saved = true;
          setSummaryDraft(id, null);
          await finishJob(id);
          setNotice(
            "Edited summary saved as a new version. Earlier versions are kept.",
          );
        });
        return saved;
      },
      segmentDraft,
      onSegmentDraft: setSegmentDraft,
      onSaveSegment: async (draft) => {
        let saved = false;
        await run(async () => {
          await api.editSegment(
            draft.meetingId,
            draft.segmentId,
            draft.baseText,
            draft.text,
          );
          saved = true;
          setSegmentDraft(null);
          await finishJob(draft.meetingId);
        });
        return saved;
      },
      onTags: (id, tags) => {
        // The list needs a fresh read.
        patchSelected(id, (current) => ({
          meeting: { ...current.meeting, tags },
        }));
        void refreshList().catch(() => undefined);
      },
      onSpeakerNames: (id, names) =>
        patchSelected(id, () => ({ speaker_names: names })),
      onActionItems: (id, items) =>
        patchSelected(id, () => ({ action_items: items })),
      onAsk: (question, threadId) => {
        const id = selected?.meeting.id;
        if (!id) return;
        void runJob("ask", async () => {
          await writer.current?.flush();
          let thread;
          try {
            thread = await api.askMeeting(id, question, threadId);
          } catch (failure) {
            // Nothing matched: nothing is sent, which is an answer, not a failure.
            if (errorCode(failure) !== "insufficient_evidence") throw failure;
            setNotice(errorMessage(failure));
            return;
          }
          patchSelected(id, (current) => ({
            question_threads: current.question_threads.some(
              (item) => item.id === thread.id,
            )
              ? current.question_threads.map((item) =>
                  item.id === thread.id ? thread : item,
                )
              : [thread, ...current.question_threads],
          }));
        });
      },
      onDeleteThread: (threadId) => {
        const id = selected?.meeting.id;
        if (!id) return;
        void run(async () => {
          const threads = await api.deleteQuestionThread(id, threadId);
          patchSelected(id, () => ({ question_threads: threads }));
        });
      },
      notes,
      notesStatus,
      tab,
      disabled,
      onTab: setTab,
      onNotes: (text) => {
        setNotes(text);
        writer.current?.update(text);
      },
      onSaveNow: () =>
        void run(async () => {
          // A failed retry already shows in the notes banner and status; no second message.
          await writer.current?.flush().catch(() => {});
        }),
      onExport: () =>
        void run(async () => {
          await writer.current?.flush();
          if (!selected) return;
          if (!settings?.vault_folder) {
            setNotice(
              "Choose a folder for exported Markdown files. You can change it in Settings.",
            );
            const updated = await api.chooseVaultFolder();
            setSettings(updated);
            if (!updated.vault_folder) return;
          }
          const result = await api.exportMeeting(selected.meeting.id);
          const extras =
            result.transcript_paths.length > 0
              ? ` Also wrote ${result.transcript_paths.length} transcript file${result.transcript_paths.length === 1 ? "" : "s"}.`
              : "";
          setNotice(
            `${result.created_copy ? "Existing file preserved; created a new snapshot" : "Exported"}: ${result.path}${extras}`,
          );
        }),
      recordingThis: active && recording.meeting_id === selected?.meeting.id,
      onDeleteMeeting: () => {
        const id = selected?.meeting.id;
        if (!id) return;
        void run(async () => {
          // The notes are being deleted; a failed final save must not block that.
          await writer.current?.flush().catch(() => {});
          await api.deleteMeeting(id);
          setSummaryDraft(id, null);
          setSegmentDraft((draft) => (draft?.meetingId === id ? null : draft));
          writer.current?.dispose();
          writer.current = null;
          selectedIdRef.current = null;
          setSelected(null);
          setNotes("");
          setNotesStatus("saved");
          setNotesError("");
          // The selection effect opens the most recent remaining meeting.
          await refreshList();
          setNotice(
            "Meeting deleted from this device. Exported Markdown was not touched.",
          );
        });
      },
      onDeleteAudio: () => {
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
      },
      onRename: (next) => {
        const id = selected?.meeting.id;
        if (!id) return;
        void run(async () => {
          const stored = await api.renameMeeting(id, next);
          // The sidebar refreshes from the backend's meeting_updated event.
          patchSelected(id, (current) => ({
            meeting: { ...current.meeting, title: stored },
          }));
        });
      },
      onRecover: () => {
        const id = selected?.meeting.id;
        if (!id) return;
        void runJob("recover", async () => {
          await writer.current?.flush();
          await api.recoverAudio(id);
          await finishJob(id);
          setNotice(
            "Recovered audio saved as new copies; the originals are unchanged.",
          );
        });
      },
    },
    controls: {
      recording,
      active,
      ready,
      controlBusy: env.controlBusy,
      disabled,
      showOpenActive:
        active &&
        !!recording.meeting_id &&
        recording.meeting_id !== selected?.meeting.id,
      onOpenActive: () => void run(() => openMeeting(recording.meeting_id!)),
      onToggle: () =>
        void runControl(async () => {
          updateRecording(
            await (recording.status === "paused" ? api.resume() : api.pause()),
          );
        }),
      onStop: () =>
        void runControl(async () => {
          updateRecording(await api.stop());
          // Stopping is independent of saving; failed drafts remain in the writer.
          await Promise.all([
            refreshList(),
            recording.meeting_id
              ? refreshProcessing(recording.meeting_id)
              : Promise.resolve(),
          ]);
        }),
      health,
    },
    close: {
      requested: env.closeRequested,
      unsavedEdits,
      notesStatus,
      notesErrorReason,
      busy: env.busy,
      controlBusy: env.controlBusy,
      onQuit: () =>
        void run(async () => {
          await writer.current?.flush();
          await api.close();
        }),
      onKeepWorking: () => {
        env.focusWorkspace();
        env.setCloseRequested(false);
      },
    },
  };

  return {
    openMeeting,
    refreshList,
    refreshProcessing,
    refreshMeeting,
    refreshSelected,
    selectedMeetingId,
    /** Opens or closes the inspector; the shell wires Ctrl+I to this. */
    toggleInspector,
    writeNotes: async () => {
      await writer.current?.flush();
    },
    disposeWriter: () => writer.current?.dispose(),
    unsavedEdits,
    notesStatus,
    pageProps,
    ask,
  };
}
