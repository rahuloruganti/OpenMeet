import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  LocalAiHardware,
  LocalAiHfFile,
  LocalAiHfHit,
  LocalAiHfListing,
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
      localAiSearchHf: vi.fn(),
      localAiHfFiles: vi.fn(),
      localAiDownloadHf: vi.fn(),
      localAiRemoveModel: vi.fn(),
      localAiCancel: vi.fn(),
      localAiUse: vi.fn(),
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

/** A .gguf file on this PC: downloaded here, or found where it is. */
function onPc(
  patch: Partial<LocalAiModel> & { id: string; name: string },
): LocalAiModel {
  return {
    description: "Downloaded from Hugging Face.",
    size_bytes: 3 * GB,
    license: null,
    fit: "ram",
    downloaded: true,
    source: "file",
    removable: true,
    ...patch,
  };
}

/** Qwen3 4B, downloaded here and run from system RAM. */
const qwen4 = onPc({
  id: "file:C:\\Models\\qwen3-4b.gguf",
  name: "qwen3-4b.gguf",
});

/** A file found on this PC: used where it is, never deleted by the app. */
const found = onPc({
  id: "file:C:\\Models\\local.gguf",
  name: "local.gguf",
  description: "A .gguf file on this PC, used where it is.",
  fit: "gpu",
  removable: false,
});

/** A repository from a search, and its single-file GGUFs as Hugging Face lists them. */
const hit: LocalAiHfHit = {
  id: "owner/tiny-GGUF",
  downloads: 1234,
  likes: 5,
  updated: "2025-01-05",
};
const q8: LocalAiHfFile = {
  filename: "tiny-Q8_0.gguf",
  size_bytes: 8 * GB,
  sha256: "a".repeat(64),
  fit: "gpu",
  downloaded: false,
};
const huge: LocalAiHfFile = {
  filename: "tiny-F16.gguf",
  size_bytes: 40 * GB,
  sha256: "b".repeat(64),
  fit: "too_big",
  downloaded: false,
};
const listing: LocalAiHfListing = {
  repo_id: "owner/tiny-GGUF",
  revision: "c".repeat(40),
  files: [huge, q8],
};

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
    models: [qwen4],
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

/** Searches for the stand-in repository and opens its file list. */
async function openRepository() {
  vi.mocked(api.localAiSearchHf).mockResolvedValue([hit]);
  vi.mocked(api.localAiHfFiles).mockResolvedValue(listing);
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search Hugging Face" }),
    "tiny",
  );
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await userEvent.click(
    await screen.findByRole("button", { name: /owner\/tiny-GGUF/ }),
  );
  expect(api.localAiHfFiles).toHaveBeenCalledWith("owner/tiny-GGUF");
}

it("offers only the GGUF files on this PC, with no catalog and no set-up card", async () => {
  await open({ models: [qwen4, found] });
  const select = screen.getByLabelText("Local model");
  expect(screen.getByRole("group", { name: "On this PC" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Catalog" })).toBeNull();
  expect(within(select).getAllByRole("option")).toHaveLength(2);
  expect(screen.queryByText("Not set up yet")).toBeNull();
  expect(screen.queryByRole("button", { name: "Set up for me" })).toBeNull();
  // Nothing is offered to download until a Hugging Face search is made.
  expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  expect(api.localAiDownloadHf).not.toHaveBeenCalled();
});

it("keeps the selected model description and license in its title", async () => {
  const description =
    "A local model for detailed meeting notes, summaries, and follow-up tasks.";
  await open({
    models: [{ ...qwen4, description, license: "Apache-2.0" }, found],
  });
  const fullDescription = `${description} · Apache-2.0`;
  expect(screen.getByText(fullDescription).getAttribute("title")).toBe(
    fullDescription,
  );

  await userEvent.selectOptions(screen.getByLabelText("Local model"), found.id);
  expect(screen.getByText(found.description).getAttribute("title")).toBe(
    found.description,
  );
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

it("searches Hugging Face for GGUF models and lists them with downloads and the update day", async () => {
  await open({ models: [] });
  const search = screen.getByRole("button", { name: "Search" });
  expect(search).toHaveProperty("disabled", true);
  vi.mocked(api.localAiSearchHf).mockResolvedValue([hit]);
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search Hugging Face" }),
    "tiny",
  );
  await userEvent.click(search);
  expect(api.localAiSearchHf).toHaveBeenCalledWith("tiny");
  const results = await screen.findByRole("list", { name: "Search results" });
  expect(within(results).getByText("owner/tiny-GGUF")).toBeTruthy();
  expect(
    within(results).getByText("1.2K downloads · updated 2025-01-05"),
  ).toBeTruthy();
});

it("says when a search finds no GGUF model", async () => {
  await open({ models: [] });
  vi.mocked(api.localAiSearchHf).mockResolvedValue([]);
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search Hugging Face" }),
    "nothing",
  );
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("No GGUF models found.")).toBeTruthy();
});

it("lists a picked repository's GGUF files with size and a fit label for this PC", async () => {
  await open({ models: [] });
  await openRepository();
  const files = await screen.findByRole("list", { name: "GGUF files" });
  expect(within(files).getByText("tiny-Q8_0.gguf")).toBeTruthy();
  expect(within(files).getByText(formatBytes(8 * GB))).toBeTruthy();
  expect(within(files).getByText("Fits your GPU")).toBeTruthy();
  expect(within(files).getByText("Too big")).toBeTruthy();
});

it("does not offer a download for a file too big for this PC", async () => {
  await open({ models: [] });
  await openRepository();
  const download = await screen.findByRole("button", {
    name: "Download tiny-F16.gguf",
  });
  expect(download).toHaveProperty("disabled", true);
});

it("downloads a file with progress, cancels it, and then lists it on this PC", async () => {
  await open({ models: [] });
  await openRepository();
  let finish: (value: LocalAiStatus) => void = () => {};
  vi.mocked(api.localAiDownloadHf).mockImplementation(
    () =>
      new Promise<LocalAiStatus>((resolve) => {
        finish = resolve;
      }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Download tiny-Q8_0.gguf" }),
  );
  expect(api.localAiDownloadHf).toHaveBeenCalledWith({
    repoId: "owner/tiny-GGUF",
    revision: listing.revision,
    filename: "tiny-Q8_0.gguf",
    sizeBytes: 8 * GB,
    sha256: "a".repeat(64),
  });
  const pending = screen.getByRole("button", {
    name: "Download tiny-Q8_0.gguf",
  });
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(pending).toHaveProperty("disabled", true);

  act(() =>
    progress({
      kind: "model",
      target: "owner/tiny-GGUF/tiny-Q8_0.gguf",
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

  await act(async () =>
    finish(
      status({
        models: [
          qwen4,
          onPc({
            id: "file:C:\\Models\\tiny-Q8_0.gguf",
            name: "tiny-Q8_0.gguf",
            size_bytes: 8 * GB,
            fit: "gpu",
          }),
        ],
      }),
    ),
  );
  expect(await screen.findByText("On this PC")).toBeTruthy();
  expect(
    within(screen.getByLabelText("Local model")).getByRole("option", {
      name: /tiny-Q8_0\.gguf/,
    }),
  ).toBeTruthy();
});

it("shows why a download failed, in one sentence", async () => {
  await open({ models: [] });
  await openRepository();
  vi.mocked(api.localAiDownloadHf).mockRejectedValue(
    new Error("The download did not match its checksum."),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Download tiny-Q8_0.gguf" }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The download did not match its checksum.",
  );
});

it("uses a file on this PC and hands the saved settings back", async () => {
  const onSettings = await open({ models: [qwen4] });
  vi.mocked(api.localAiUse).mockResolvedValue(savedSettings);
  vi.mocked(api.localAiStatus).mockResolvedValue(
    status({ models: [qwen4], active_model: qwen4.id, in_use: true }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Use qwen3-4b.gguf" }),
  );
  expect(api.localAiUse).toHaveBeenCalledWith(qwen4.id);
  expect(onSettings).toHaveBeenCalledWith(savedSettings);
  const inUse = await screen.findByRole("button", { name: "In use" });
  expect(inUse).toHaveProperty("disabled", true);
});

it("removes a model this app downloaded, and never a file used in place", async () => {
  await open({ models: [qwen4, found] });
  await userEvent.selectOptions(screen.getByLabelText("Local model"), qwen4.id);
  vi.mocked(api.localAiRemoveModel).mockResolvedValue(
    status({ models: [found] }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Remove qwen3-4b.gguf" }),
  );
  expect(api.localAiRemoveModel).toHaveBeenCalledWith(qwen4.id);
  await waitFor(() =>
    expect(
      within(screen.getByLabelText("Local model")).queryByRole("option", {
        name: /qwen3-4b/,
      }),
    ).toBeNull(),
  );

  await userEvent.selectOptions(screen.getByLabelText("Local model"), found.id);
  expect(
    screen.queryByRole("button", { name: "Remove local.gguf" }),
  ).toBeNull();
});

it("leaves files too big for this PC out of the list and says how many", async () => {
  await open({
    models: [
      onPc({
        id: "file:C:\\Models\\big-a.gguf",
        name: "big-a.gguf",
        size_bytes: 40 * GB,
        fit: "too_big",
      }),
      onPc({
        id: "file:C:\\Models\\big-b.gguf",
        name: "big-b.gguf",
        size_bytes: 70 * GB,
        fit: "too_big",
      }),
      qwen4,
    ],
  });
  const select = screen.getByLabelText("Local model");
  expect(within(select).queryByRole("option", { name: /big-a/ })).toBeNull();
  expect(
    screen.getByText(
      "2 more models are too big for this PC, so they are not listed.",
    ),
  ).toBeTruthy();
  // Only the model that fits is left to choose.
  expect(within(select).getAllByRole("option")).toHaveLength(1);
});

it("turns the local server on and off", async () => {
  await open();
  vi.mocked(api.localAiStart).mockResolvedValue(
    status({ server: "running", active_model: qwen4.id }),
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

it("uses plain words for the PC and for each fit, with a sentence per fit", async () => {
  await open({ models: [qwen4, found] });
  expect(screen.getByText("Your PC")).toBeTruthy();
  expect(screen.queryByText("This machine")).toBeNull();
  expect(screen.getByText("Stays on this device")).toBeTruthy();
  // The first file on this PC is picked; its fit has a sentence of its own.
  expect(screen.getByText("Uses system RAM")).toBeTruthy();
  expect(
    screen.getByText(
      "Runs from system memory, which is slower than a graphics card.",
    ),
  ).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Local model"), found.id);
  expect(
    screen.getByText("Fits your graphics card, so it runs fastest on this PC."),
  ).toBeTruthy();
});
