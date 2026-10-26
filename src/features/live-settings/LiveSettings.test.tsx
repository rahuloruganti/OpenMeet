import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { LiveModels, Settings } from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { initialSettings } from "../../shared/test/app-harness";
import { LiveSettings } from "./LiveSettings";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    liveModels: vi.fn(),
    saveLiveSettings: vi.fn(),
    liveModelInstall: vi.fn(),
    liveModelCancel: vi.fn(),
    onLiveModelProgress: vi.fn(),
  },
}));

const settings: Settings = { ...initialSettings, live_transcript: true };

const listing = (over: Partial<LiveModels> = {}): LiveModels => ({
  models: [
    {
      id: "",
      label: "Same as Transcription",
      kind: "same",
      installed: true,
      download_bytes: null,
      leaves_device: false,
      languages: [],
      reason: null,
    },
    {
      id: "stream:kroko-en",
      label: "Streaming English (Zipformer)",
      kind: "streaming",
      installed: false,
      download_bytes: 57_267_600,
      leaves_device: false,
      languages: ["en"],
      reason: null,
    },
    {
      id: "stream:nemo-en-80ms",
      label: "Streaming English (NeMo)",
      kind: "streaming",
      installed: true,
      download_bytes: null,
      leaves_device: false,
      languages: ["en"],
      reason: null,
    },
    {
      id: "cloud",
      label: "Cloud speech",
      kind: "cloud",
      installed: true,
      download_bytes: null,
      leaves_device: true,
      languages: [],
      reason: null,
    },
  ],
  selected: "",
  ready: true,
  reason: null,
  installing: null,
  ...over,
});

let progress: (value: {
  model_id: string;
  done: number;
  total: number;
  stage: string;
  error: string | null;
}) => void = () => {};

beforeEach(() => {
  vi.mocked(api.liveModels).mockResolvedValue(listing());
  vi.mocked(api.saveLiveSettings).mockImplementation(async (model) => ({
    ...settings,
    live_model: model,
  }));
  vi.mocked(api.liveModelInstall).mockResolvedValue(listing());
  vi.mocked(api.liveModelCancel).mockResolvedValue(listing());
  vi.mocked(api.onLiveModelProgress).mockImplementation(async (callback) => {
    progress = callback;
    return () => {};
  });
});

it("has no Show text switch: the live transcript is always on", () => {
  render(<LiveSettings settings={settings} disabled={false} />);
  expect(
    screen.queryByRole("switch", { name: "Show text while recording" }),
  ).toBeNull();
  expect(screen.queryByText("Show text while recording")).toBeNull();
});

it("lists the models with their download size and saves a new one", async () => {
  render(<LiveSettings settings={settings} disabled={false} />);
  const select = (await screen.findByLabelText(
    "Live model",
  )) as HTMLSelectElement;
  expect(
    screen.getByRole("option", {
      name: "Streaming English (Zipformer) (download 54.6 MB)",
    }),
  ).toBeTruthy();

  await userEvent.selectOptions(select, "stream:kroko-en");
  expect(api.saveLiveSettings).toHaveBeenCalledWith("stream:kroko-en");
});

it("downloads only when Download is clicked", async () => {
  vi.mocked(api.liveModels).mockResolvedValue(
    listing({ selected: "stream:kroko-en" }),
  );
  render(
    <LiveSettings
      settings={{ ...settings, live_model: "stream:kroko-en" }}
      disabled={false}
    />,
  );

  const download = await screen.findByRole("button", { name: "Download" });
  expect(api.liveModelInstall).not.toHaveBeenCalled();
  await userEvent.click(download);
  expect(api.liveModelInstall).toHaveBeenCalledWith("stream:kroko-en");
});

it("shows the download progress and cancels it", async () => {
  vi.mocked(api.liveModels).mockResolvedValue(
    listing({ selected: "stream:kroko-en" }),
  );
  const { container } = render(
    <LiveSettings
      settings={{ ...settings, live_model: "stream:kroko-en" }}
      disabled={false}
    />,
  );
  await screen.findByRole("button", { name: "Download" });

  await userEvent.click(screen.getByRole("button", { name: "Download" }));
  await act(async () => {
    progress({
      model_id: "stream:kroko-en",
      done: 28_633_800,
      total: 57_267_600,
      stage: "downloading",
      error: null,
    });
  });

  expect(await screen.findByText("Downloading 50%")).toBeTruthy();
  expect(container.querySelector("progress")?.getAttribute("value")).toBe(
    "28633800",
  );

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.liveModelCancel).toHaveBeenCalled();
});

it("shows no 'Leaves this device' tag on a cloud model", async () => {
  vi.mocked(api.liveModels).mockResolvedValue(listing({ selected: "cloud" }));
  render(
    <LiveSettings
      settings={{ ...settings, live_model: "cloud" }}
      disabled={false}
    />,
  );

  expect(
    await screen.findByRole("option", { name: "Cloud speech" }),
  ).toBeTruthy();
  expect(screen.queryByText("Leaves this device")).toBeNull();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

it("says why the chosen model cannot run yet", async () => {
  vi.mocked(api.liveModels).mockResolvedValue(
    listing({ ready: false, reason: "Download the selected streaming model." }),
  );
  render(<LiveSettings settings={settings} disabled={false} />);
  expect(
    await screen.findByText("Download the selected streaming model."),
  ).toBeTruthy();
});

it("names the live model row, and says what Same as Transcription uses", async () => {
  render(<LiveSettings settings={settings} disabled={false} />);
  expect(screen.getByRole("region", { name: "Live transcript" })).toBeTruthy();
  expect(screen.getByLabelText("Live model")).toBeTruthy();
  expect(
    screen.getByText("Same as Transcription uses the Speech model above."),
  ).toBeTruthy();
});

it("shows no 'Leaves this device' tag, even when the Same row is marked as leaving", async () => {
  vi.mocked(api.liveModels).mockResolvedValue(
    listing({
      models: listing().models.map((model) =>
        model.id === "" ? { ...model, leaves_device: true } : model,
      ),
    }),
  );
  render(<LiveSettings settings={settings} disabled={false} />);
  expect(
    await screen.findByRole("option", { name: "Same as Transcription" }),
  ).toBeTruthy();
  expect(screen.queryByText("Leaves this device")).toBeNull();
  expect(
    screen.getByText("Same as Transcription uses the Speech model above."),
  ).toBeTruthy();
});

it("makes Same as Transcription unavailable in cloud speech mode and says why, once", async () => {
  const reason =
    "Same as Transcription cannot run live with cloud speech; choose Cloud connection to send live audio.";
  vi.mocked(api.liveModels).mockResolvedValue(
    listing({
      ready: false,
      reason,
      models: listing().models.map((model) =>
        model.id === ""
          ? { ...model, installed: false, leaves_device: false, reason }
          : model,
      ),
    }),
  );
  render(
    <LiveSettings
      settings={{ ...settings, stt_mode: "cloud" }}
      disabled={false}
    />,
  );
  const same = await screen.findByRole("option", {
    name: "Same as Transcription",
  });
  expect(same).toHaveProperty("disabled", true);
  expect(screen.getAllByText(reason)).toHaveLength(1);
  expect(
    screen.queryByText("Same as Transcription uses the Speech model above."),
  ).toBeNull();
});
