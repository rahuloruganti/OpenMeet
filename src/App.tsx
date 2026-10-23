import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorCode,
  errorMessage,
  isLocalBase,
  type Meeting,
  type MeetingDetail,
  type MicApp,
  type KeyStatus,
  type ProviderRole,
  type SttDownloadProgress,
  type SttStatus,
  type AudioDevices,
  type AudioHealth,
  type RecordingState,
  type SearchHit,
  type Settings,
  type SummaryVersion,
  type SessionProcessingSnapshot,
} from "./lib/api";
import { createNoteWriter } from "./lib/note-writer";
import { formatTimestamp } from "./lib/timestamps";
import { MeetingSidebar } from "./components/MeetingSidebar";
import {
  MeetingWorkspace,
  type ContentTab,
  type SegmentDraft,
  type SummaryDraft,
} from "./components/MeetingWorkspace";
import { RecordingControls } from "./components/RecordingControls";
import { LibraryQuestion } from "./components/LibraryQuestion";
import { SetupPanel } from "./components/SetupPanel";
import {
  processingDefault,
  forgetLegacyProcessing,
  legacyProcessing,
  stageLabel,
  type ProcessingChoice,
} from "./lib/processing";
import { formatBytes } from "./lib/meeting-labels";
import { FirstRunSetup } from "./components/FirstRunSetup";
import {
  SettingsPanel,
  shortcutsDirty,
  type AiBlock,
  type OpenSettings,
  type SettingsSection,
  type SttDraft,
} from "./components/SettingsPanel";
import { sttDirty } from "./components/TranscriptionSettings";

type Writer = ReturnType<typeof createNoteWriter>;

/** Names for capture tracks in the audio-gap notice. */
const gapTrackLabels: Record<string, string> = {
  mic: "Microphone",
  system: "System audio",
};

/** Final summary processing waits for this session's saved notes to be acknowledged. */
const awaitingNotes = (snapshot: SessionProcessingSnapshot) =>
  snapshot.plan.scope.kind === "final" &&
  snapshot.plan.scope.summary !== null &&
  !!snapshot.workflow?.notes_barrier &&
  snapshot.workflow.notes_revision === null &&
  ["finalizing_audio", "transcribing", "awaiting_notes"].includes(
    snapshot.workflow.stage,
  );

export function App() {
  const desktop = api.isDesktop();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [controlBusy, setControlBusy] = useState(false);
  const controlBusyRef = useRef(false);
  const [error, setError] = useState("");
  const report = (failure: unknown) => setError(errorMessage(failure));
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
  const autoProcessing = processingDefault(settings);
  const chooseAutoProcessing = (choice: ProcessingChoice) =>
    void run(async () =>
      setSettings(await api.saveProcessingDefault(choice.mode, choice.summary)),
    );
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
  // Meeting detection: apps holding the microphone, and ones already answered this session.
  const [micApps, setMicApps] = useState<MicApp[]>([]);
  const [dismissedApps, setDismissedApps] = useState<string[]>([]);
  const [detectionSupported, setDetectionSupported] = useState(false);
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [microphone, setMicrophone] = useState("");
  const [output, setOutput] = useState("");
  const [health, setHealth] = useState<AudioHealth | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  // Dismissed banners, keyed by meeting and message so a new recording or a changed message shows again.
  const [dismissedCapture, setDismissedCapture] = useState("");
  const [dismissedGaps, setDismissedGaps] = useState("");
  // Revision of each meeting's processing state that was dismissed; a new revision shows again.
  const [dismissedProcessing, setDismissedProcessing] = useState<
    Record<string, number>
  >({});
  const speechReady =
    settings?.stt_mode === "cloud"
      ? (keyStatus.cloud_stt === "present" ||
          isLocalBase(settings.cloud_stt?.base_url ?? "")) &&
        !!settings.cloud_stt?.model
      : stt?.installed === true;
  // Unsaved summary edits per meeting; quitting warns before discarding them.
  const [summaryDrafts, setSummaryDrafts] = useState<
    Record<string, SummaryDraft>
  >({});
  const [segmentDraft, setSegmentDraft] = useState<SegmentDraft | null>(null);
  const unsavedEdits =
    Object.keys(summaryDrafts).length > 0 || segmentDraft !== null;
  const setSummaryDraft = (id: string, draft: SummaryDraft | null) =>
    setSummaryDrafts((drafts) => {
      const next = { ...drafts };
      if (draft) next[id] = draft;
      else delete next[id];
      return next;
    });
  const [panel, setPanel] = useState<"setup" | "settings" | "library" | null>(
    null,
  );
  // Kept mounted once opened so an answer survives following one of its links.
  const [libraryOpened, setLibraryOpened] = useState(false);
  // A library-answer citation waiting for its meeting to be shown.
  const [pendingJump, setPendingJump] = useState<{
    meetingId: string;
    ms: number | null;
  } | null>(null);
  const [settingsTab, setSettingsTab] =
    useState<SettingsSection>("transcription");
  const panelRef = useRef<HTMLElement | null>(null);
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  // Closing a banner, card or panel hands focus here, so Tab resumes from the workspace.
  const workspace = useRef<HTMLElement | null>(null);
  const focusWorkspace = () => workspace.current?.focus();
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectionRequest = useRef(0);
  const jobRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [audioBytes, setAudioBytes] = useState<number | null>(null);
  const [summaryVersions, setSummaryVersions] = useState<SummaryVersion[]>([]);
  const [processing, setProcessing] =
    useState<SessionProcessingSnapshot | null>(null);
  const processingRevisions = useRef(new Map<string, number>());
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
        // The notes banner already shows a note-save failure; say why this action stopped.
        if (!keepMessages && failure === noteFailure.current)
          setError(
            "That action needs your notes saved first. Fix the problem above or copy your text, then try again.",
          );
        else report(failure);
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
        api.onMicrophoneApps((apps) => {
          setMicApps(apps);
          // An app that stopped and starts again later prompts again.
          setDismissedApps((ids) =>
            ids.filter((id) => apps.some((app) => app.id === id)),
          );
        }),
      );
      void api.detectionSupported().then(setDetectionSupported, () => {});
      await register(
        api.onSessionProcessingChanged((notification) => {
          void refreshProcessing(notification.meeting_id).catch(report);
          if (selectedIdRef.current === notification.meeting_id)
            void refreshMeeting(notification.meeting_id).catch(report);
        }),
      );
      await register(
        api.onMeetingUpdated(() => {
          void refreshList().catch(report);
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
      // One-time move of the default earlier versions kept in webview storage.
      // The old value is forgotten only once the database holds a default; a failed save retries
      // on the next start.
      const legacy = legacyProcessing();
      if (legacy && preferences.processing_mode !== "recording")
        forgetLegacyProcessing();
      else if (legacy)
        void api
          .saveProcessingDefault(legacy.mode, legacy.summary)
          .then((saved) => {
            forgetLegacyProcessing();
            if (!disposed) setSettings(saved);
          })
          .catch(() => undefined);
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
      if (id) void refreshProcessing(id).catch(report);
      void api.getRecordingState().then(updateRecording, report);
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
  // Never while OpenMeet itself records; a prompt only opens setup, it never starts capture.
  const detectedApp =
    settings?.detection_enabled && !active
      ? micApps.find(
          (app) =>
            !settings.detection_ignored.some((item) => item.id === app.id) &&
            !dismissedApps.includes(app.id),
        )
      : undefined;
  useEffect(() => {
    if (detectedApp) void api.requestAttention().catch(() => {});
  }, [detectedApp?.id]);
  // A device plugged in or allowed after startup appears without restarting. Only an empty choice
  // is filled; a chosen device that is unavailable is never replaced.
  // Fills only an empty choice; a saved, unavailable device is never replaced.
  const applyDevices = (discovered: AudioDevices) => {
    setDevices(discovered);
    setMicrophone(
      (current) =>
        current ||
        (settings?.microphone_id ?? discovered.microphones[0]?.id ?? ""),
    );
    setOutput(
      (current) =>
        current || (settings?.output_id ?? discovered.outputs[0]?.id ?? ""),
    );
  };
  // Devices connected after startup (a Bluetooth headset, say) appear without a manual refresh.
  useEffect(() => {
    if (panel !== "setup" || !desktop) return;
    let live = true;
    api.listDevices().then(
      (discovered) => live && applyDevices(discovered),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [panel, desktop]);
  const refreshDevices = () =>
    void run(async () => {
      const discovered = await api.listDevices();
      applyDevices(discovered);
      setNotice(
        `Devices refreshed: ${discovered.microphones.length} microphone${discovered.microphones.length === 1 ? "" : "s"}, ${discovered.outputs.length} output${discovered.outputs.length === 1 ? "" : "s"}.`,
      );
    });
  // Shown until finished or skipped; any other panel takes precedence.
  const firstRun =
    desktop && !!settings && !settings.setup_done && panel === null;
  const installStt = () =>
    void runJob("install", async () => {
      updateStt(await api.sttInstall());
      setNotice("Speech engine and models downloaded and verified.");
    });
  const dismissApp = (id: string) =>
    setDismissedApps((ids) => (ids.includes(id) ? ids : [...ids, id]));
  const openPanel = (
    next: "setup" | "settings" | "library",
    trigger: HTMLButtonElement,
  ) => {
    panelTrigger.current = trigger;
    setPanel(next);
  };
  const openSettings: OpenSettings = (section, trigger) => {
    setSettingsTab(section);
    openPanel("settings", trigger);
  };
  useEffect(() => {
    if (panel) {
      panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    } else {
      const trigger = panelTrigger.current;
      // A trigger inside a panel that is now hidden (the library behind Settings) cannot take focus.
      if (trigger?.isConnected && !trigger.closest("[hidden]")) trigger.focus();
      else if (trigger) focusWorkspace();
      panelTrigger.current = null;
    }
  }, [panel]);
  // Finishing or skipping the first-run wizard hands focus to the workspace. A panel opened over
  // the wizard also makes firstRun false, but it keeps its own focus.
  const wasFirstRun = useRef(firstRun);
  useEffect(() => {
    if (wasFirstRun.current && !firstRun && panel === null) focusWorkspace();
    wasFirstRun.current = firstRun;
  }, [firstRun, panel]);

  // Unsaved shortcut or transcription drafts; closing Settings discards them after asking.
  const settingsDirty =
    shortcutsDirty(settings, shortcut, stopShortcut) ||
    sttDirty(settings, sttDraft);
  const closeSettings = useCallback(() => {
    if (settingsDirty && !window.confirm("Discard unsaved settings?")) return;
    // The drafts live here, not in the panel, so discarding resets them to the saved values.
    if (settings) {
      setShortcut(settings.pause_shortcut);
      setStopShortcut(settings.stop_shortcut ?? "");
      setSttDraft(settings);
    }
    setPanel(null);
  }, [settings, settingsDirty]);

  useEffect(() => {
    if (!panel || closeRequested) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape inside a Settings field belongs to that field and must not close the page.
      const target = event.target;
      if (
        panel === "settings" &&
        target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) &&
        panelRef.current?.contains(target)
      )
        return;
      event.preventDefault();
      if (panel === "settings") closeSettings();
      else setPanel(null);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [panel, closeRequested, closeSettings]);
  const disabled = !ready || busy || controlBusy;
  const hasSummaryInput =
    notes.trim().length > 0 || (selected?.segments.length ?? 0) > 0;
  // Why the summary/question provider cannot be used; rewrites need nothing more.
  const llmBlocked: AiBlock | null = !settings?.llm
    ? {
        message:
          "AI notes aren't set up yet. Choose a connection and a model in Settings → AI notes. A server on this computer needs no key.",
        section: "ai",
      }
    : !isLocalBase(settings.llm.base_url) && keyStatus.llm !== "present"
      ? {
          message:
            "The AI notes connection needs an API key. Add it under Settings → Connections.",
          section: "connections",
        }
      : !settings.llm.model
        ? {
            message: "Choose a model for AI notes in Settings → AI notes.",
            section: "ai",
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
        onNewRecording={(trigger) => openPanel("setup", trigger)}
        onSettings={(trigger) => {
          setSettingsTab("transcription");
          openPanel("settings", trigger);
        }}
        onLibrary={(trigger) => {
          setLibraryOpened(true);
          openPanel("library", trigger);
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
      <main className="workspace" ref={workspace} tabIndex={-1}>
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
                  : panel === "library"
                    ? "Ask across meetings"
                    : "Workspace"}
            </span>
          </div>
          <details className="privacy-details">
            <summary>
              <span className="status-dot" aria-hidden="true" /> Local workspace
            </summary>
            <div className="privacy-popover">
              <strong>Your workspace is stored on this device.</strong>
              <p>
                Recording saves microphone and system audio locally. Local
                transcription stays on this computer. Cloud transcription
                uploads audio, and summaries and questions send text to your
                selected provider when you use them.
              </p>
              <p>
                Capture is not yet hardware-qualified. Local files are
                unencrypted.
              </p>
            </div>
          </details>
        </header>
        <div className="feedback-stack">
          {detectedApp && (
            <div
              className="detection-card"
              role="status"
              aria-label="Meeting detected"
            >
              <span>
                <strong>{detectedApp.name}</strong> is using your microphone.
                Record this meeting?
              </span>
              <div className="panel-actions">
                <button
                  className="primary"
                  disabled={disabled}
                  onClick={(event) => {
                    dismissApp(detectedApp.id);
                    if (title === "Untitled meeting")
                      setTitle(`${detectedApp.name} meeting`);
                    openPanel("setup", event.currentTarget);
                  }}
                >
                  Set up recording
                </button>
                <button
                  onClick={() => {
                    focusWorkspace();
                    dismissApp(detectedApp.id);
                  }}
                >
                  Not now
                </button>
                <button
                  onClick={() => {
                    focusWorkspace();
                    dismissApp(detectedApp.id);
                    void run(async () =>
                      setSettings(
                        await api.setDetectionIgnored(
                          detectedApp.id,
                          detectedApp.name,
                          true,
                        ),
                      ),
                    );
                  }}
                >
                  Never for {detectedApp.name}
                </button>
              </div>
            </div>
          )}
          {!desktop && (
            <p role="alert">
              Open this app with <code>corepack pnpm tauri dev</code>. The
              browser preview cannot access the desktop database.
            </p>
          )}
          {/* Above the action errors, which point at it ("Fix the problem above"). */}
          {notesError && (
            <p className="error" role="alert">
              Notes not saved: {notesErrorReason}. You can't switch meetings or
              quit until this is fixed. Copy your text or use Save notes now to
              retry.
            </p>
          )}
          {error && (
            <div className="error" role="alert">
              {error}{" "}
              <button
                onClick={() => {
                  focusWorkspace();
                  setError("");
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {recording.error && captureKey !== dismissedCapture && (
            <div className="error" role="alert">
              <span>Capture: {recording.error}</span>{" "}
              <button
                aria-label="Dismiss capture error"
                onClick={() => {
                  focusWorkspace();
                  setDismissedCapture(captureKey);
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {recording.processing_notice &&
            recording.meeting_id === selected?.meeting.id && (
              <p className="notice" role="status">
                {recording.processing_notice}
              </p>
            )}
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => {
                  focusWorkspace();
                  setNotice("");
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {desktop && !ready && !error && (
            <p role="status">Opening local database…</p>
          )}
          {gapNotice && gapKey !== dismissedGaps && (
            <div className="notice" role="status">
              <span>{gapNotice}</span>
              <button
                aria-label="Dismiss audio gap notice"
                onClick={() => {
                  focusWorkspace();
                  setDismissedGaps(gapKey);
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {active && health?.error && (
            <p className="error" role="alert">
              Audio: {health.error}
            </p>
          )}
          {panel === null &&
            processing &&
            processing.meeting_id === selected?.meeting.id &&
            dismissedProcessing[processing.meeting_id] !==
              processing.revision && (
              <section
                className="processing-panel"
                aria-label="Session processing"
              >
                <h3>Automatic processing</h3>
                <p role="status">
                  Stage:{" "}
                  {stageLabel(processing.workflow?.stage ?? processing.state)}
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
                    Used {processing.workflow.requests_used}{" "}
                    {processing.workflow.requests_used === 1
                      ? "request"
                      : "requests"}
                    , {formatBytes(processing.workflow.upload_bytes_used)} of
                    audio and {formatBytes(processing.workflow.text_bytes_used)}{" "}
                    of text.
                  </p>
                )}
                {awaitingNotes(processing) && (
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
                  "needs_attention",
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
                  "needs_attention",
                ].includes(processing.workflow?.stage ?? processing.state) && (
                  <button
                    disabled={busy || active}
                    onClick={() =>
                      void run(async () => {
                        applyProcessing(
                          await api.retrySessionProcessing(
                            processing.meeting_id,
                          ),
                        );
                        await refreshProcessing(processing.meeting_id);
                      })
                    }
                  >
                    Retry processing
                  </button>
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
                {["completed", "cancelled"].includes(
                  processing.workflow?.stage ?? processing.state,
                ) && (
                  <button
                    aria-label="Dismiss processing status"
                    onClick={() => {
                      focusWorkspace();
                      setDismissedProcessing((dismissed) => ({
                        ...dismissed,
                        [processing.meeting_id]: processing.revision,
                      }));
                    }}
                  >
                    Dismiss
                  </button>
                )}
              </section>
            )}
        </div>

        {panel === "setup" && (
          <SetupPanel
            panelRef={panelRef}
            speechReady={speechReady}
            sttMode={settings?.stt_mode ?? "local"}
            devices={devices}
            title={title}
            microphone={microphone}
            output={output}
            disabled={disabled}
            active={active}
            processing={autoProcessing}
            onOpenSettings={() => {
              setSettingsTab("recording");
              setPanel("settings");
            }}
            onTitle={setTitle}
            onMicrophone={setMicrophone}
            onOutput={setOutput}
            onRefreshDevices={refreshDevices}
            onClose={() => setPanel(null)}
            onStartCapture={() =>
              void run(async () => {
                await writer.current?.flush();
                const state = await api.startCapture(title, {
                  microphoneId: microphone,
                  outputId: output,
                });
                updateRecording(state);
                setPanel(null);
                if (state.meeting_id) await openMeeting(state.meeting_id);
                await refreshList();
              })
            }
          />
        )}
        {libraryOpened && (
          <LibraryQuestion
            hidden={panel !== "library"}
            panelRef={panel === "library" ? panelRef : null}
            meetings={meetings}
            recipes={settings?.recipes ?? []}
            connectionRevision={`${settings?.llm?.revision ?? 0}`}
            llmBlocked={llmBlocked}
            onOpenSettings={openSettings}
            disabled={disabled}
            onClose={() => setPanel(null)}
            onOpen={(id, ms) =>
              void run(async () => {
                await openMeeting(id);
                if (selectedIdRef.current !== id) return;
                setPanel(null);
                setPendingJump({ meetingId: id, ms });
              })
            }
          />
        )}
        <MeetingWorkspace
          pendingJump={pendingJump}
          onJumpDone={() => setPendingJump(null)}
          hidden={panel !== null || firstRun}
          selected={selected}
          firstRun={ready && meetings.length === 0}
          job={job}
          speechReady={speechReady}
          sttMode={settings?.stt_mode ?? "local"}
          connectionRevision={`${settings?.llm?.revision ?? 0}:${settings?.cloud_stt?.revision ?? 0}`}
          enhanceBlocked={enhanceBlocked}
          llmBlocked={llmBlocked}
          onOpenSettings={openSettings}
          onTranscribe={() => {
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
              .catch(report)
          }
          getRecordingOffset={async () => {
            try {
              const state = await api.getRecordingState();
              updateRecording(state);
              return state.recording_offset_ms;
            } catch (failure) {
              report(failure);
              return null;
            }
          }}
          onSeek={async (kind, sessionMs) => {
            const id = selected?.meeting.id;
            if (!id) return null;
            try {
              return await api.audioPosition(id, kind, sessionMs);
            } catch (failure) {
              report(failure);
              return null;
            }
          }}
          onGenerate={(template) => {
            const id = selected?.meeting.id;
            if (!id) return;
            void runJob("summary", async () => {
              await writer.current?.flush();
              await api.generateSummary(id, template);
              await finishJob(id);
              setNotice(
                "Summary generated and saved. Only notes and transcript text were sent to your selected provider.",
              );
            });
          }}
          versions={summaryVersions}
          customTemplates={settings?.summary_templates ?? []}
          defaultTemplate={settings?.summary_default ?? "general-v1"}
          recipes={settings?.recipes ?? []}
          summaryInstructions={settings?.summary_instructions ?? ""}
          summaryDraft={
            selected ? summaryDrafts[selected.meeting.id] : undefined
          }
          onSummaryDraft={(draft) => {
            if (selected) setSummaryDraft(selected.meeting.id, draft);
          }}
          onSaveSummaryEdit={async (draft) => {
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
          }}
          segmentDraft={segmentDraft}
          onSegmentDraft={setSegmentDraft}
          onSaveSegment={async (draft) => {
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
          }}
          onTags={(id, tags) => {
            // The list needs a fresh read.
            patchSelected(id, (current) => ({
              meeting: { ...current.meeting, tags },
            }));
            void refreshList().catch(() => undefined);
          }}
          onSpeakerNames={(id, names) =>
            patchSelected(id, () => ({ speaker_names: names }))
          }
          onActionItems={(id, items) =>
            patchSelected(id, () => ({ action_items: items }))
          }
          onAsk={(question, threadId) => {
            const id = selected?.meeting.id;
            if (!id) return;
            void runJob("ask", async () => {
              await writer.current?.flush();
              let thread;
              try {
                thread = await api.askMeeting(id, question, threadId);
              } catch (failure) {
                // Nothing matched: nothing is sent, which is an answer, not a failure.
                if (errorCode(failure) !== "insufficient_evidence")
                  throw failure;
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
          }}
          onDeleteThread={(threadId) => {
            const id = selected?.meeting.id;
            if (!id) return;
            void run(async () => {
              const threads = await api.deleteQuestionThread(id, threadId);
              patchSelected(id, () => ({ question_threads: threads }));
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
              // A failed retry already shows in the notes banner and status; no second message.
              await writer.current?.flush().catch(() => {});
            })
          }
          onExport={() =>
            void run(async () => {
              await writer.current?.flush();
              if (!selected) return;
              if (!settings?.vault_folder) {
                setNotice(
                  "Choose a folder for exported Markdown files. OpenMeet remembers it; change it later in Settings → Export & storage.",
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
              setSummaryDraft(id, null);
              setSegmentDraft((draft) =>
                draft?.meetingId === id ? null : draft,
              );
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
              patchSelected(id, (current) => ({
                meeting: { ...current.meeting, title: stored },
              }));
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

        {firstRun && settings && (
          <FirstRunSetup
            panelRef={panelRef}
            settings={settings}
            devices={devices}
            stt={stt}
            sttProgress={sttProgress}
            installing={job === "install"}
            onInstallStt={installStt}
            onRefreshDevices={refreshDevices}
            onSettings={(next) => {
              setSettings(next);
              void api.sttStatus().then(updateStt, () => undefined);
            }}
            onKeyStatus={updateKeyStatus}
            onDevices={(mic, out) => {
              setMicrophone(mic);
              setOutput(out);
            }}
          />
        )}
        {panel === "settings" && (
          <SettingsPanel
            panelRef={panelRef}
            initialSection={settingsTab}
            devices={devices}
            microphone={microphone}
            output={output}
            onDefaultDevices={(mic, out) =>
              void run(async () => {
                const saved = await api.saveDefaultDevices(mic, out);
                setSettings(saved);
                setMicrophone(mic);
                setOutput(out);
              })
            }
            audioBytes={audioBytes}
            detectionSupported={detectionSupported}
            onDetection={(enabled) =>
              void run(async () =>
                setSettings(await api.saveDetection(enabled)),
              )
            }
            onDetectionIgnored={(app, ignored) =>
              void run(async () =>
                setSettings(
                  await api.setDetectionIgnored(app.id, app.name, ignored),
                ),
              )
            }
            onRefreshDevices={refreshDevices}
            onSummaryDefault={(template) =>
              void run(async () =>
                setSettings(await api.saveSummaryDefault(template)),
              )
            }
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
            onCancelStt={() => void api.cancelModelDownload().catch(report)}
            onInstallStt={installStt}
            onShortcut={setShortcut}
            onRunSetup={() =>
              void run(async () => {
                setSettings(await api.saveSetupDone(false));
                setPanel(null);
              })
            }
            onClose={closeSettings}
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
            {unsavedEdits && (
              <p role="alert">
                You have an unsaved summary or transcript edit. Keep working to
                save it, or quit to discard it.
              </p>
            )}
            {notesStatus === "error" && (
              <p role="alert">
                Your notes could not be saved: {notesErrorReason}. OpenMeet will
                not quit until they are saved. Copy your text, or keep working
                and retry.
              </p>
            )}
            <button
              autoFocus={!unsavedEdits && notesStatus !== "error"}
              disabled={busy || controlBusy}
              onClick={() =>
                void run(async () => {
                  await writer.current?.flush();
                  await api.close();
                })
              }
            >
              {unsavedEdits
                ? "Discard unsaved edits and quit"
                : "Save and quit"}
            </button>
            <button
              autoFocus={unsavedEdits || notesStatus === "error"}
              disabled={busy || controlBusy}
              onClick={() => {
                focusWorkspace();
                setCloseRequested(false);
              }}
            >
              Keep working
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
