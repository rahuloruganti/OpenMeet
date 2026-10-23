import {
  useCallback,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import {
  api,
  type AudioDevices,
  type KeyStatus,
  type MicApp,
  type ProviderRole,
  type Settings,
  type SttDownloadProgress,
  type SttStatus,
} from "../../../shared/api/api";
import type { ProcessingChoice } from "../../../entities/processing";
import {
  sttDirty,
  type SttDraft,
} from "../../../features/transcription-settings";
import {
  SettingsPanel,
  shortcutsDirty,
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
  setNotice: (notice: string) => void;
  updateStt: (status: SttStatus | null) => void;
  openPanel: (
    next: "setup" | "settings" | "library",
    trigger: HTMLButtonElement,
  ) => void;
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
  detectionSupported: boolean;
  keyStatus: Record<ProviderRole, KeyStatus>;
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
 * Settings screen: the shortcut and transcription drafts it edits, and the handlers
 * that save them. Drafts live here (not in the panel) so closing resets them.
 */
export function useSettingsPage(env: SettingsPageEnv) {
  const {
    settings,
    setSettings,
    run,
    report,
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
    detectionSupported,
    keyStatus,
    updateKeyStatus,
    stt,
    sttProgress,
    installing,
    installStt,
    refreshDevices,
    autoProcessing,
    chooseAutoProcessing,
  } = env;
  const [section, setSection] = useState<SettingsSection>("transcription");
  const [shortcut, setShortcut] = useState("");
  const [stopShortcut, setStopShortcut] = useState("");
  const [sttDraft, setSttDraft] = useState<SttDraft>({
    stt_language: "auto",
    stt_prompt: "",
    stt_model: "small",
  });

  const openSettings: OpenSettings = (next, trigger) => {
    setSection(next);
    openPanel("settings", trigger);
  };

  /** Opens Settings on a section from inside a panel that keeps the focus. */
  const showSection = (next: SettingsSection) => {
    setSection(next);
    showPanel();
  };

  /** Saved values replace the drafts after startup reads them. */
  const loadPreferences = useCallback((preferences: Settings) => {
    setShortcut(preferences.pause_shortcut);
    setStopShortcut(preferences.stop_shortcut ?? "");
    setSttDraft(preferences);
  }, []);

  // Unsaved shortcut or transcription drafts; closing Settings discards them after asking.
  const dirty =
    shortcutsDirty(settings, shortcut, stopShortcut) ||
    sttDirty(settings, sttDraft);
  const closeSettings = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved settings?")) return;
    // The drafts live here, not in the panel, so discarding resets them to the saved values.
    if (settings) {
      setShortcut(settings.pause_shortcut);
      setStopShortcut(settings.stop_shortcut ?? "");
      setSttDraft(settings);
    }
    closePanel();
  }, [settings, dirty, closePanel]);

  const pageProps: SettingsPageProps = {
    panelRef,
    initialSection: section,
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
    detectionSupported,
    onDetection: (enabled) =>
      void run(async () => setSettings(await api.saveDetection(enabled))),
    onDetectionIgnored: (app: MicApp, ignored: boolean) =>
      void run(async () =>
        setSettings(await api.setDetectionIgnored(app.id, app.name, ignored)),
      ),
    onRefreshDevices: refreshDevices,
    onSummaryDefault: (template) =>
      void run(async () => setSettings(await api.saveSummaryDefault(template))),
    processing: autoProcessing,
    onProcessing: chooseAutoProcessing,
    settings,
    disabled: env.disabled,
    shortcut,
    keyStatus,
    onKeyStatus: updateKeyStatus,
    onSettings: setSettings,
    onImported: async () => updateStt(await api.sttStatus()),
    onSttMode: (mode) =>
      void run(async () => setSettings(await api.saveSttMode(mode))),
    stt,
    sttProgress,
    installing,
    onCancelStt: () => void api.cancelModelDownload().catch(report),
    onInstallStt: installStt,
    onShortcut: setShortcut,
    onRunSetup: () =>
      void run(async () => {
        setSettings(await api.saveSetupDone(false));
        closePanel();
      }),
    onClose: closeSettings,
    onChooseFolder: () =>
      void run(async () => {
        setSettings(await api.chooseVaultFolder());
      }),
    onSaveShortcut: () =>
      void run(async () => {
        const updated = await api.saveSettings(
          shortcut,
          stopShortcut.trim() || null,
        );
        setSettings(updated);
        setShortcut(updated.pause_shortcut);
        setStopShortcut(updated.stop_shortcut ?? "");
        setNotice("Shortcuts saved.");
      }),
    stopShortcut,
    onStopShortcut: setStopShortcut,
    sttDraft,
    onStt: (change) => setSttDraft((draft) => ({ ...draft, ...change })),
    onSaveStt: () =>
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
      }),
    onExportOptions: (options) =>
      void run(async () => {
        setSettings(await api.saveExportOptions(options));
      }),
  };

  return {
    openSettings,
    showSection,
    closeSettings,
    loadPreferences,
    pageProps,
  };
}
