import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  LocalAiHardware,
  LocalAiJob,
  LocalAiModel,
  LocalAiStatus,
  Settings,
} from "../../shared/api/api";
import { api } from "../../shared/api/api";
import { formatBytes } from "../../entities/meeting";
import { LocalAi } from "./LocalAi";

vi.mock("../../shared/api/api", async (original) => {
  const actual = await original<typeof import("../../shared/api/api")>();
  return {
    ...actual,
    api: {
      localAiStatus: vi.fn(),
      localAiInstallEngine: vi.fn(),
      localAiDownloadModel: vi.fn(),
      localAiRemoveModel: vi.fn(),
      localAiCancel: vi.fn(),
      localAiUse: vi.fn(),
      localAiQuickstart: vi.fn(),
      localAiStart: vi.fn(),
      localAiStop: vi.fn(),
      onLocalAiProgress: vi.fn(),
      detectLocalServers: vi.fn(),
    },
  };
});

const GB = 1024 ** 3;

const hardware: LocalAiHardware = {
  gpu_name: "NVIDIA GeForce RTX 4090",
  gpu_vendor: "nvidia",
  vram_bytes: 24 * GB,
  ram_bytes: 32 * GB,
  ram_available_bytes: 20 * GB,
  backend: "cuda",
};

function model(
  patch: Partial<LocalAiModel> & { id: string; name: string },
): LocalAiModel {
  return {
    description: "General notes and answers.",
    size_bytes: 9 * GB,
    license: "Apache-2.0",
    fit: "gpu",
    recommended: false,
    downloaded: false,
    source: "catalog",
    ...patch,
  };
}

/** Qwen3 14B (recommended, not downloaded) beside Qwen3 4B (downloaded, runs from RAM). */
const qwen14 = model({ id: "qwen3-14b", name: "Qwen3 14B", recommended: true });
const qwen4 = model({
  id: "qwen3-4b",
  name: "Qwen3 4B",
  size_bytes: 3 * GB,
  fit: "ram",
  downloaded: true,
});

function status(patch: Partial<LocalAiStatus> = {}): LocalAiStatus {
  return {
    hardware,
    engine_installed: true,
    engine_tag: "b11671",
    engine_download_bytes: 0,
    server: "stopped",
    server_error: null,
    active_model: null,
    in_use: false,
    models: [qwen14, qwen4],
    job: null,
    ...patch,
  };
}

/** The settings a save returns; the page passes them around, never reads them here. */
const savedSettings = { theme: "dark" } as Settings;

let progress: (job: LocalAiJob) => void = () => {};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.onLocalAiProgress).mockImplementation(async (callback) => {
    progress = callback;
    return () => {};
  });
  vi.mocked(api.detectLocalServers).mockResolvedValue([]);
  vi.mocked(api.localAiCancel).mockResolvedValue();
  vi.mocked(api.localAiStatus).mockResolvedValue(status());
});

/** Renders the group with the section open and waits for the first status. */
async function open(patch: Partial<LocalAiStatus> = {}, onSettings = vi.fn()) {
  vi.mocked(api.localAiStatus).mockResolvedValue(status(patch));
  render(<LocalAi active disabled={false} onSettings={onSettings} />);
  await screen.findByLabelText("Local model");
  return onSettings;
}

it("sets a model up with one click, shows its progress and can cancel", async () => {
  const onSettings = await open({
    engine_installed: false,
    engine_download_bytes: 578 * 1024 ** 2,
    models: [qwen14],
  });
  vi.mocked(api.localAiQuickstart).mockResolvedValue(savedSettings);
  await userEvent.click(screen.getByRole("button", { name: "Set up for me" }));
  expect(api.localAiQuickstart).toHaveBeenCalledTimes(1);
  expect(onSettings).toHaveBeenCalledWith(savedSettings);

  act(() =>
    progress({
      kind: "quickstart",
      target: "b11671",
      phase: "download",
      downloaded: 512,
      total: 2048,
    }),
  );
  const bar = await screen.findByRole("progressbar", {
    name: "Setup progress",
  });
  expect(bar).toHaveProperty("value", 512);
  await userEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
  expect(api.localAiCancel).toHaveBeenCalledTimes(1);
});

it("installs the engine from its row and then shows the pinned build", async () => {
  await open({
    engine_installed: false,
    engine_download_bytes: 578 * 1024 ** 2,
  });
  const install = screen.getByRole("button", {
    name: `Install · ${formatBytes(578 * 1024 ** 2)}`,
  });
  vi.mocked(api.localAiInstallEngine).mockResolvedValue(
    status({ engine_installed: true }),
  );
  await userEvent.click(install);
  expect(api.localAiInstallEngine).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Installed · b11671 · CUDA")).toBeTruthy();
});

it("downloads the picked model and then offers it for use", async () => {
  await open();
  // The recommended model is picked until you choose another.
  expect(screen.getByLabelText("Local model")).toHaveProperty(
    "value",
    "qwen3-14b",
  );
  vi.mocked(api.localAiDownloadModel).mockResolvedValue(
    status({ models: [{ ...qwen14, downloaded: true }, qwen4] }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Download Qwen3 14B" }),
  );
  expect(api.localAiDownloadModel).toHaveBeenCalledWith("qwen3-14b");
  expect(
    await screen.findByRole("button", { name: "Use Qwen3 14B" }),
  ).toBeTruthy();
});

it("shows a download's progress, marks the button busy and cancels it", async () => {
  await open();
  let finish: (value: LocalAiStatus) => void = () => {};
  vi.mocked(api.localAiDownloadModel).mockImplementation(
    () =>
      new Promise<LocalAiStatus>((resolve) => {
        finish = resolve;
      }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Download Qwen3 14B" }),
  );
  expect(api.localAiDownloadModel).toHaveBeenCalledWith("qwen3-14b");
  const pending = screen.getByRole("button", { name: "Download Qwen3 14B" });
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(pending).toHaveProperty("disabled", true);

  act(() =>
    progress({
      kind: "model",
      target: "qwen3-14b",
      phase: "download",
      downloaded: 100,
      total: 400,
    }),
  );
  const bar = await screen.findByRole("progressbar", {
    name: "Download progress",
  });
  expect(bar).toHaveProperty("value", 100);
  await userEvent.click(
    screen.getByRole("button", { name: "Cancel download" }),
  );
  expect(api.localAiCancel).toHaveBeenCalledTimes(1);
  await act(async () => finish(status()));
});

it("uses a downloaded model and hands the saved settings back", async () => {
  const onSettings = await open();
  await userEvent.selectOptions(
    screen.getByLabelText("Local model"),
    "qwen3-4b",
  );
  vi.mocked(api.localAiUse).mockResolvedValue(savedSettings);
  vi.mocked(api.localAiStatus).mockResolvedValue(
    status({ active_model: "qwen3-4b", in_use: true }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Use Qwen3 4B" }));
  expect(api.localAiUse).toHaveBeenCalledWith("qwen3-4b");
  expect(onSettings).toHaveBeenCalledWith(savedSettings);
  const inUse = await screen.findByRole("button", { name: "In use" });
  expect(inUse).toHaveProperty("disabled", true);
});

it("removes a downloaded catalog model", async () => {
  await open();
  await userEvent.selectOptions(
    screen.getByLabelText("Local model"),
    "qwen3-4b",
  );
  vi.mocked(api.localAiRemoveModel).mockResolvedValue(
    status({ models: [qwen14] }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Remove Qwen3 4B" }),
  );
  expect(api.localAiRemoveModel).toHaveBeenCalledWith("qwen3-4b");
  await waitFor(() =>
    expect(
      within(screen.getByLabelText("Local model")).queryByRole("option", {
        name: /Qwen3 4B/,
      }),
    ).toBeNull(),
  );
});

it("leaves models that are too big out of the list and says how many", async () => {
  await open({
    models: [
      model({
        id: "llama-70b",
        name: "Llama 70B",
        size_bytes: 40 * GB,
        fit: "too_big",
      }),
      model({
        id: "llama-120b",
        name: "Llama 120B",
        size_bytes: 70 * GB,
        fit: "too_big",
      }),
      qwen14,
    ],
  });
  const select = screen.getByLabelText("Local model");
  expect(
    within(select).queryByRole("option", { name: /Llama 70B/ }),
  ).toBeNull();
  expect(
    screen.getByText(
      "2 more models are too big for this PC, so they are not listed.",
    ),
  ).toBeTruthy();
  // Only the model that fits is left to choose.
  expect(within(select).getAllByRole("option")).toHaveLength(1);
});

it("offers .gguf files found on this PC with Use only", async () => {
  const found = model({
    id: "file:C:\\Models\\local.gguf",
    name: "local.gguf",
    fit: "ram",
    source: "file",
  });
  await open({ models: [qwen14, found] });
  expect(screen.getByRole("group", { name: "Catalog" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "On this PC" })).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Local model"), found.id);
  vi.mocked(api.localAiUse).mockResolvedValue(savedSettings);
  const use = screen.getByRole("button", { name: "Use local.gguf" });
  expect(
    screen.queryByRole("button", { name: "Remove local.gguf" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Download local\.gguf/ }),
  ).toBeNull();
  await userEvent.click(use);
  expect(api.localAiUse).toHaveBeenCalledWith(found.id);
});

it("turns the local server on and off", async () => {
  await open();
  vi.mocked(api.localAiStart).mockResolvedValue(
    status({ server: "running", active_model: "qwen3-4b" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
  expect(api.localAiStart).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("On")).toBeTruthy();

  vi.mocked(api.localAiStop).mockResolvedValue(status({ server: "stopped" }));
  await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
  expect(api.localAiStop).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Off")).toBeTruthy();
});

it("shows a failed server as one sentence with the fix", async () => {
  const sentence = "The local server stopped twice. Turn it on again.";
  await open({ server: "failed", server_error: sentence });
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(sentence);
  expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
});

it("describes this machine, and says when there is no GPU", async () => {
  await open();
  expect(
    screen.getByText("NVIDIA GeForce RTX 4090 · 24.00 GB VRAM · 32.00 GB RAM"),
  ).toBeTruthy();
  expect(screen.getByText("Stays on this device")).toBeTruthy();
});

it("says there is no GPU when the probe found none", async () => {
  await open({
    hardware: {
      ...hardware,
      gpu_name: null,
      gpu_vendor: null,
      vram_bytes: null,
      backend: "cpu",
    },
  });
  expect(screen.getByText("No GPU found · 32.00 GB RAM")).toBeTruthy();
});

it("names other local chat servers in one line", async () => {
  vi.mocked(api.detectLocalServers).mockResolvedValue([
    {
      name: "Ollama",
      base_url: "http://127.0.0.1:11434/v1",
      kind: "chat",
      needs_key: false,
      models: [],
    },
    {
      name: "Whisper server",
      base_url: "http://127.0.0.1:9000/v1",
      kind: "speech",
      needs_key: false,
      models: [],
    },
  ]);
  render(<LocalAi active disabled={false} onSettings={vi.fn()} />);
  expect(
    await screen.findByText(
      "Ollama is running · use it with New connection above",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Whisper server/)).toBeNull();
});

it("uses plain words for the PC, the first step and each fit", async () => {
  await open({ models: [qwen14, qwen4] });
  expect(screen.getByText("Your PC")).toBeTruthy();
  expect(screen.queryByText("This machine")).toBeNull();
  expect(screen.getByText("Stays on this device")).toBeTruthy();
  // The engine and model are installed here, so there is no first-step card to show.
  expect(screen.queryByRole("button", { name: "Set up for me" })).toBeNull();
  // Each fit has a sentence of its own, not only a badge.
  await userEvent.selectOptions(
    screen.getByLabelText("Local model"),
    "qwen3-4b",
  );
  expect(screen.getByText("Uses system RAM")).toBeTruthy();
  expect(
    screen.getByText(
      "Runs from system memory, which is slower than a graphics card.",
    ),
  ).toBeTruthy();
  await userEvent.selectOptions(
    screen.getByLabelText("Local model"),
    "qwen3-14b",
  );
  expect(
    screen.getByText("Fits your graphics card, so it runs fastest on this PC."),
  ).toBeTruthy();
});

it("makes Set up for me the first step, and says what it downloads", async () => {
  await open({ engine_installed: false, models: [qwen14] });
  expect(screen.getByText("Not set up yet")).toBeTruthy();
  expect(
    screen.getByText(
      "OpenMeet downloads the engine and the best model for this PC, then uses it. Nothing downloads until you click.",
    ),
  ).toBeTruthy();
  // Nothing has been fetched before the click.
  expect(api.localAiQuickstart).not.toHaveBeenCalled();
  expect(api.localAiDownloadModel).not.toHaveBeenCalled();
  expect(api.localAiInstallEngine).not.toHaveBeenCalled();
});
