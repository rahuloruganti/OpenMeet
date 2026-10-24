import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type Settings } from "../../../shared/api/api";
import { useSettingsPage, type SettingsPageEnv } from "./use-settings-page";

vi.mock("../../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../../shared/api/api")>()),
  api: { saveUiPrefs: vi.fn() },
}));

const settings = {
  theme: "system",
  inspector_open: true,
  stt_mode: "local",
  stt_language: "auto",
  stt_prompt: "",
  stt_model: "small",
  vault_folder: null,
  export: {
    transcript: true,
    summary: true,
    filename: "title",
    transcript_formats: ["txt"],
  },
} as unknown as Settings;

const env = () => {
  const report = vi.fn();
  // The shell's runner: it runs the task and reports a failure instead of rethrowing.
  const run = (task: () => Promise<void>) => void task().catch(report);
  return {
    settings,
    setSettings: vi.fn(),
    disabled: false,
    run,
    report,
    setNotice: vi.fn(),
    updateStt: vi.fn(),
    openPanel: vi.fn(),
    showPanel: vi.fn(),
    closePanel: vi.fn(),
    panelRef: { current: null },
    devices: null,
    microphone: "",
    output: "",
    setMicrophone: vi.fn(),
    setOutput: vi.fn(),
    audioBytes: null,
    detectionSupported: true,
    updateKeyStatus: vi.fn(),
    stt: null,
    sttProgress: null,
    installing: false,
    installStt: vi.fn(),
    refreshDevices: vi.fn(),
    autoProcessing: { mode: "recording", summary: null },
    chooseAutoProcessing: vi.fn(),
  } satisfies SettingsPageEnv;
};

beforeEach(() => {
  vi.resetAllMocks();
  delete document.documentElement.dataset.theme;
});

it("saves the theme and publishes the settings the backend returned", async () => {
  const saved = { ...settings, theme: "dark" } as Settings;
  vi.mocked(api.saveUiPrefs).mockResolvedValue(saved);
  const input = env();
  const { result } = renderHook(() => useSettingsPage(input));

  act(() => result.current.pageProps.onTheme?.("dark"));

  await waitFor(() => expect(input.setSettings).toHaveBeenCalledWith(saved));
  expect(api.saveUiPrefs).toHaveBeenCalledWith("dark", true);
  // One theme writer: App's effect owns the attribute, so the hook never touches it.
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

it("keeps the old selection and reports the failure when a theme save fails", async () => {
  vi.mocked(api.saveUiPrefs).mockRejectedValue(new Error("Disk full."));
  const input = env();
  const { result } = renderHook(() => useSettingsPage(input));

  act(() => result.current.pageProps.onTheme?.("light"));

  await waitFor(() => expect(input.report).toHaveBeenCalled());
  // Nothing was published, so the segmented choice still shows the stored theme.
  expect(input.setSettings).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

it("owns the section the panel shows and accepts a pick back from it", () => {
  const input = env();
  const { result } = renderHook(() => useSettingsPage(input));
  const trigger = document.createElement("button");

  expect(result.current.pageProps.section).toBe("general");
  act(() => result.current.openSettings("export", trigger));
  expect(result.current.pageProps.section).toBe("export");
  expect(input.openPanel).toHaveBeenCalledWith("settings", trigger);

  // A tab click inside the panel comes back here, so the two cannot disagree.
  act(() => result.current.pageProps.onSection?.("recording"));
  expect(result.current.pageProps.section).toBe("recording");

  act(() => result.current.showSection("about"));
  expect(result.current.pageProps.section).toBe("about");
});
