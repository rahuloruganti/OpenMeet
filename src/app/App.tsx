import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  isLocalBase,
  type AudioDevices,
  type AudioHealth,
  type KeyStatus,
  type MicApp,
  type ProviderRole,
  type RecordingState,
  type Settings,
  type SttDownloadProgress,
  type SttStatus,
} from "../shared/api/api";
import {
  forgetLegacyProcessing,
  legacyProcessing,
  processingDefault,
  type ProcessingChoice,
} from "../entities/processing";
import { MeetingPage, useMeetingPage } from "../pages/meeting";
import { SettingsPage, useSettingsPage } from "../pages/settings";
import { FirstRunPage, SetupPage, useSetupPage } from "../pages/setup";

export function App() {
  const desktop = api.isDesktop();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [controlBusy, setControlBusy] = useState(false);
  const controlBusyRef = useRef(false);
  const [error, setError] = useState("");
  const report = (failure: unknown) => setError(errorMessage(failure));
  const noteFailure = useRef<unknown>(undefined);
  const [notice, setNotice] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
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
  const [audioBytes, setAudioBytes] = useState<number | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const [panel, setPanel] = useState<"setup" | "settings" | "library" | null>(
    null,
  );
  // Kept mounted once opened so an answer survives following one of its links.
  const [libraryOpened, setLibraryOpened] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  // Closing a banner, card or panel hands focus here, so Tab resumes from the workspace.
  const workspace = useRef<HTMLElement | null>(null);
  const focusWorkspace = () => workspace.current?.focus();
  const jobRef = useRef(false);
  const [recording, setRecording] = useState<RecordingState>({
    revision: 0,
    status: "idle",
    meeting_id: null,
    source: null,
    error: null,
    recording_offset_ms: null,
  });
  const active =
    recording.status === "recording" || recording.status === "paused";

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

  const autoProcessing = processingDefault(settings);
  const chooseAutoProcessing = (choice: ProcessingChoice) =>
    void run(async () =>
      setSettings(await api.saveProcessingDefault(choice.mode, choice.summary)),
    );
  const updateRecording = useCallback((next: RecordingState) => {
    setRecording((previous) =>
      next.revision >= previous.revision ? next : previous,
    );
  }, []);
  const openPanel = (
    next: "setup" | "settings" | "library",
    trigger: HTMLButtonElement,
  ) => {
    panelTrigger.current = trigger;
    setPanel(next);
  };
  const closePanel = useCallback(() => setPanel(null), []);
  const openLibrary = (trigger: HTMLButtonElement) => {
    setLibraryOpened(true);
    openPanel("library", trigger);
  };
  // Shown until finished or skipped; any other panel takes precedence.
  const firstRun =
    desktop && !!settings && !settings.setup_done && panel === null;
  const disabled = !ready || busy || controlBusy;
  const speechReady =
    settings?.stt_mode === "cloud"
      ? (keyStatus.cloud_stt === "present" ||
          isLocalBase(settings.cloud_stt?.base_url ?? "")) &&
        !!settings.cloud_stt?.model
      : stt?.installed === true;
  // A device plugged in or allowed after startup appears without restarting. Only an empty choice
  // is filled; a chosen device that is unavailable is never replaced.
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
  const refreshDevices = () =>
    void run(async () => {
      const discovered = await api.listDevices();
      applyDevices(discovered);
      setNotice(
        `Devices refreshed: ${discovered.microphones.length} microphone${discovered.microphones.length === 1 ? "" : "s"}, ${discovered.outputs.length} output${discovered.outputs.length === 1 ? "" : "s"}.`,
      );
    });
  const installStt = () =>
    void runJob("install", async () => {
      updateStt(await api.sttInstall());
      setNotice("Speech engine and models downloaded and verified.");
    });
  const dismissApp = (id: string) =>
    setDismissedApps((ids) => (ids.includes(id) ? ids : [...ids, id]));
  // Never while OpenMeet itself records; a prompt only opens setup, it never starts capture.
  const detectedApp =
    settings?.detection_enabled && !active
      ? micApps.find(
          (app) =>
            !settings.detection_ignored.some((item) => item.id === app.id) &&
            !dismissedApps.includes(app.id),
        )
      : undefined;

  const settingsPage = useSettingsPage({
    settings,
    setSettings,
    disabled,
    run,
    report,
    setNotice,
    updateStt,
    openPanel,
    showPanel: () => setPanel("settings"),
    closePanel,
    panelRef,
    devices,
    microphone,
    output,
    setMicrophone,
    setOutput,
    audioBytes,
    detectionSupported,
    keyStatus,
    updateKeyStatus,
    stt,
    sttProgress,
    installing: job === "install",
    installStt,
    refreshDevices,
    autoProcessing,
    chooseAutoProcessing,
  });
  const meeting = useMeetingPage({
    desktop,
    ready,
    disabled,
    busy,
    controlBusy,
    firstRun,
    settings,
    setSettings,
    notice,
    setNotice,
    error,
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
    openLibrary,
    openSettings: settingsPage.openSettings,
    libraryOpened,
    panelRef,
    workspaceRef: workspace,
    focusWorkspace,
    title,
    setTitle,
    detectedApp,
    dismissDetectedApp: dismissApp,
    speechReady,
    audioBytes,
    setAudioBytes,
    job,
    transcribeProgress,
    closeRequested,
    setCloseRequested,
    noteFailure,
  });
  const setupPage = useSetupPage({
    firstRun,
    settings,
    setSettings,
    disabled,
    active,
    run,
    showSettings: settingsPage.showSection,
    closePanel,
    panelRef,
    openMeeting: meeting.openMeeting,
    refreshList: meeting.refreshList,
    writeNotes: meeting.writeNotes,
    updateRecording,
    title,
    setTitle,
    microphone,
    output,
    setMicrophone,
    setOutput,
    devices,
    speechReady,
    autoProcessing,
    refreshDevices,
    updateStt,
    updateKeyStatus,
    stt,
    sttProgress,
    installing: job === "install",
    installStt,
  });

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
          void meeting.refreshProcessing(notification.meeting_id).catch(report);
          void meeting.refreshSelected(notification.meeting_id).catch(report);
        }),
      );
      await register(
        api.onMeetingUpdated(() => {
          void meeting.refreshList().catch(report);
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
      settingsPage.loadPreferences(preferences);
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
      const list = await meeting.refreshList();
      if (disposed) return;
      if (list[0]) await meeting.openMeeting(list[0].id);
      if (!disposed) setReady(true);
    })().catch((failure: unknown) => {
      if (!disposed) setError(errorMessage(failure));
    });
    return () => {
      disposed = true;
      for (const unlisten of listeners) unlisten();
      meeting.disposeWriter();
    };
  }, [
    desktop,
    meeting.openMeeting,
    meeting.refreshList,
    updateRecording,
    updateKeyStatus,
    updateStt,
    meeting.refreshProcessing,
    meeting.refreshSelected,
  ]);

  useEffect(() => {
    if (!desktop) return;
    const reconnect = () => {
      const id = meeting.selectedMeetingId();
      if (id) void meeting.refreshProcessing(id).catch(report);
      void api.getRecordingState().then(updateRecording, report);
    };
    window.addEventListener("focus", reconnect);
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("online", reconnect);
    };
  }, [
    desktop,
    meeting.refreshProcessing,
    meeting.selectedMeetingId,
    updateRecording,
  ]);

  useEffect(() => {
    if (job === null) {
      setSttProgress(null);
      setTranscribeProgress({});
    }
  }, [job]);
  useEffect(() => setHealth(null), [recording.meeting_id, active]);
  useEffect(() => {
    if (detectedApp) void api.requestAttention().catch(() => {});
  }, [detectedApp?.id]);
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
      if (panel === "settings") settingsPage.closeSettings();
      else setPanel(null);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [panel, closeRequested, settingsPage.closeSettings]);

  return (
    <MeetingPage {...meeting.pageProps}>
      {panel === "setup" && <SetupPage {...setupPage.pageProps} />}
      {firstRun && settings && <FirstRunPage {...setupPage.firstRunProps} />}
      {panel === "settings" && <SettingsPage {...settingsPage.pageProps} />}
    </MeetingPage>
  );
}
