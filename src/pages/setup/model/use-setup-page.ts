import { type ComponentProps, type RefObject } from "react";
import {
  api,
  type AudioDevices,
  type KeyStatus,
  type ProviderRole,
  type RecordingState,
  type Settings,
  type SttDownloadProgress,
  type SttStatus,
} from "../../../shared/api/api";
import type { ProcessingChoice } from "../../../entities/processing";
import { FirstRunSetup } from "../../../widgets/first-run-setup";
import { SetupPanel } from "../../../widgets/setup-panel";
import type { SettingsSection } from "../../../widgets/settings-panel";

export type SetupPageProps = ComponentProps<typeof SetupPanel>;
export type FirstRunPageProps = ComponentProps<typeof FirstRunSetup>;

/** What the setup screens need from the app shell, which outlives them. */
export type SetupPageEnv = {
  firstRun: boolean;
  settings: Settings | null;
  setSettings: (settings: Settings) => void;
  disabled: boolean;
  active: boolean;
  run: (task: () => Promise<void>) => void;
  /** Opens Settings on a section, keeping the panel that currently has focus. */
  showSettings: (section: SettingsSection) => void;
  closePanel: () => void;
  panelRef: RefObject<HTMLElement | null>;
  openMeeting: (id: string) => Promise<void>;
  refreshList: () => Promise<unknown>;
  writeNotes: () => Promise<void>;
  updateRecording: (next: RecordingState) => void;
  title: string;
  setTitle: (title: string) => void;
  microphone: string;
  output: string;
  setMicrophone: (id: string) => void;
  setOutput: (id: string) => void;
  devices: AudioDevices | null;
  speechReady: boolean;
  autoProcessing: ProcessingChoice;
  refreshDevices: () => void;
  updateStt: (status: SttStatus | null) => void;
  updateKeyStatus: (role: ProviderRole, status: KeyStatus) => void;
  stt: SttStatus | null;
  sttProgress: SttDownloadProgress | null;
  installing: boolean;
  installStt: () => void;
};

/**
 * New-recording screen and the first-run wizard: capture settings, the device list,
 * and starting capture in a fresh meeting.
 */
export function useSetupPage(env: SetupPageEnv) {
  const {
    settings,
    setSettings,
    run,
    showSettings,
    closePanel,
    openMeeting,
    refreshList,
    writeNotes,
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
    installing,
    installStt,
  } = env;

  const startCapture = () =>
    void run(async () => {
      await writeNotes();
      const state = await api.startCapture(title, {
        microphoneId: microphone,
        outputId: output,
      });
      updateRecording(state);
      closePanel();
      if (state.meeting_id) await openMeeting(state.meeting_id);
      await refreshList();
    });

  const pageProps: SetupPageProps = {
    panelRef: env.panelRef,
    speechReady,
    sttMode: settings?.stt_mode ?? "local",
    devices,
    title,
    microphone,
    output,
    disabled: env.disabled,
    active: env.active,
    processing: autoProcessing,
    onOpenSettings: () => showSettings("recording"),
    onTitle: setTitle,
    onMicrophone: setMicrophone,
    onOutput: setOutput,
    onRefreshDevices: refreshDevices,
    onClose: closePanel,
    onStartCapture: startCapture,
  };

  const firstRunProps: FirstRunPageProps = {
    panelRef: env.panelRef,
    settings: settings!,
    devices,
    stt,
    sttProgress,
    installing,
    onInstallStt: installStt,
    onRefreshDevices: refreshDevices,
    onSettings: (next) => {
      setSettings(next);
      void api.sttStatus().then(updateStt, () => undefined);
    },
    onKeyStatus: updateKeyStatus,
    onDevices: (mic, out) => {
      setMicrophone(mic);
      setOutput(out);
    },
  };

  return { pageProps, firstRunProps };
}
