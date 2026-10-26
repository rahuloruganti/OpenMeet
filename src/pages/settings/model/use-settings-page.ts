import {
  useCallback,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import {
  api,
  errorMessage,
  type AudioDevices,
  type KeyStatus,
  type MicApp,
  type ProviderRole,
  type Settings,
  type SttDownloadProgress,
  type SttStatus,
  type Theme,
} from "../../../shared/api/api";
import type { ProcessingChoice } from "../../../entities/processing";
import type { SttDraft } from "../../../features/transcription-settings";
import {
  SettingsPanel,
  type SettingsSection,
} from "../../../widgets/settings-panel";
import type { OpenSettings } from "../../../shared/ui/settings-link";

export type SettingsPageProps = ComponentProps<typeof SettingsPanel>;

/** What the Settings screen needs from the app shell, which outlives it. */
export type SettingsPageEnv = {
  settings: Settings | null;
  setSettings: (settings: Settings) => void;
  disabled: boolean;
  run: (task: () => Promise<void>) => void;
  report: (failure: unknown) => void;
  error: string;
  setError: (error: string) => void;
  setNotice: (notice: string) => void;
  updateStt: (status: SttStatus | null) => void;
  openPanel: (next: "setup" | "settings", trigger: HTMLButtonElement) => void;
  /** Shows the panel without taking a trigger to hand focus back to. */
  showPanel: () => void;
  closePanel: () => void;
  panelRef: RefObject<HTMLElement | null>;
  devices: AudioDevices | null;
  microphone: string;
  output: string;
  setMicrophone: (id: string) => void;
  setOutput: (id: string) => void;
  audioBytes: number | null;
  updateKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  installStt: () => void;
  refreshDevices: () => void;
  autoProcessing: ProcessingChoice;
  chooseAutoProcessing: (choice: ProcessingChoice) => void;
};

/**
 * Settings screen state: the open section and the handlers that save each change.
 * Every control saves as it changes, so nothing is drafted here any more.
 *
 * The theme is written in one place only: App's effect sets `data-theme` from
 * `settings.theme`. This hook saves the choice and publishes the settings it gets back, so a
 * failed save leaves the old selection on screen. A refused shortcut is explained in its group;
 * other failures go to the shell's error line.
 */
export function useSettingsPage(env: SettingsPageEnv) {
  const {
    settings,
    setSettings,
    run,
    setNotice,
    updateStt,
    openPanel,
    showPanel,
    closePanel,
    panelRef,
    devices,
    microphone,
    output,
    setMicrophone,
    setOutput,
    audioBytes,
    updateKeyStatus,
    stt,
    sttProgress,
    installing,
    installStt,
    refreshDevices,
    autoProcessing,
    chooseAutoProcessing,
  } = env;
  const [section, setSection] = useState<SettingsSection>("general");
  // A refused shortcut save, explained in the Shortcuts group: the shell's error line is on Meetings only.
  const [shortcutError, setShortcutError] = useState("");

  const openSettings: OpenSettings = (next, trigger) => {
    setSection(next);
    openPanel("settings", trigger);
  };

  /** Opens Settings on a section from inside a panel that keeps the focus. */
  const showSection = (next: SettingsSection) => {
    setSection(next);
    showPanel();
  };

  /** Kept for the shell's startup call; App's effect is the only thing that applies the theme. */
  const loadPreferences = useCallback((preferences: Settings) => {
    void preferences;
  }, []);

  const saveTheme = (theme: Theme) =>
    void run(async () => {
      const saved = await api.saveUiPrefs(
        theme,
        settings?.inspector_open ?? true,
      );
      setSettings(saved);
    });

  const saveStt = (draft: SttDraft) =>
    void run(async () => {
      const modelChanged = draft.stt_model !== settings?.stt_model;
      const saved = await api.saveSttSettings(
        draft.stt_language,
        draft.stt_prompt,
        draft.stt_model,
      );
      setSettings(saved);
      // A new model changes what the engine can do; the language does not.
      if (modelChanged) updateStt(await api.sttStatus());
    });

  // A catalog pick is saved first, so the install downloads the model just chosen. The install
  // runs as a job with its own lock, so starting it here does not wait on this task.
  const downloadStt = (draft: SttDraft) =>
    void run(async () => {
      setSettings(
        await api.saveSttSettings(
          draft.stt_language,
          draft.stt_prompt,
          draft.stt_model,
        ),
      );
      installStt();
    });

  const pageProps: SettingsPageProps = {
    panelRef,
    // The hook owns the visible section, so a tab click and a shell request cannot disagree.
    section,
    onSection: setSection,
    devices,
    microphone,
    output,
    onDefaultDevices: (mic, out) =>
      void run(async () => {
        const saved = await api.saveDefaultDevices(mic, out);
        setSettings(saved);
        setMicrophone(mic);
        setOutput(out);
      }),
    audioBytes,
    onAutoCapture: (enabled) =>
      void run(async () => setSettings(await api.saveAutoCapture(enabled))),
    onDetectionIgnored: (app: MicApp, ignored: boolean) =>
      void run(async () =>
        setSettings(await api.setDetectionIgnored(app.id, app.name, ignored)),
      ),
    onRefreshDevices: refreshDevices,
    onSummaryDefault: (template) =>
      void run(async () => setSettings(await api.saveSummaryDefault(template))),
    onTheme: saveTheme,
    processing: autoProcessing,
    onProcessing: chooseAutoProcessing,
    settings,
    disabled: env.disabled,
    onKeyStatus: updateKeyStatus,
    onSettings: setSettings,
    onImported: async () => updateStt(await api.sttStatus()),
    onSttMode: (mode) =>
      void run(async () => setSettings(await api.saveSttMode(mode))),
    stt,
    sttProgress,
    installing,
    onCancelStt: () => void api.cancelModelDownload().catch(env.report),
    onInstallStt: installStt,
    onSaveStt: saveStt,
    onDownloadStt: downloadStt,
    shortcutError,
    error: env.error,
    onDismissError: () => env.setError(""),
    onSaveShortcuts: (pause, stop) =>
      void run(async () => {
        setShortcutError("");
        try {
          const saved = await api.saveSettings(pause, stop.trim() || null);
          setSettings(saved);
          setNotice("Shortcuts saved.");
        } catch (failure) {
          setShortcutError(errorMessage(failure));
        }
      }),
    onRunSetup: () =>
      void run(async () => {
        setSettings(await api.saveSetupDone(false));
        closePanel();
      }),
    onClose: closePanel,
    onChooseFolder: () =>
      void run(async () => {
        setSettings(await api.chooseVaultFolder());
      }),
    onExportOptions: (options) =>
      void run(async () => {
        setSettings(await api.saveExportOptions(options));
      }),
  };

  return {
    openSettings,
    showSection,
    closeSettings: closePanel,
    loadPreferences,
    pageProps,
  };
}
