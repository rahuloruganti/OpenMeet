import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../shared/api/api";
import { ModelLibrary } from "./ModelLibrary";
vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    onModelLibraryProgress: vi.fn(),
    chooseModelFolder: vi.fn(),
    scanLocalModels: vi.fn(),
    importLocalModel: vi.fn(),
    searchHfModels: vi.fn(),
    listHfFiles: vi.fn(),
    downloadHfModel: vi.fn(),
    downloadHfFolder: vi.fn(),
    cancelModelDownload: vi.fn(),
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.onModelLibraryProgress).mockResolvedValue(() => {});
});
it("scans common folders once on open, makes no network request, and respects a cancelled folder picker", async () => {
  vi.mocked(api.chooseModelFolder).mockResolvedValue(null);
  render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "whisper");
  expect(api.searchHfModels).not.toHaveBeenCalled();
  expect(api.scanLocalModels).toHaveBeenCalledOnce();
  expect(api.scanLocalModels).toHaveBeenCalledWith(null);
  await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
  expect(api.scanLocalModels).toHaveBeenCalledOnce();
});
it("imports only catalog candidates, hides files it cannot use, and updates found models on custom folder scan", async () => {
  vi.mocked(api.scanLocalModels).mockResolvedValue({
    models: [
      { path: "C:/small.bin", format: "whisper", size: 123, model_id: "small" },
      { path: "C:/model.gguf", format: "gguf", size: 99, model_id: null },
    ],
    folders: [],
    truncated: true,
  });
  vi.mocked(api.importLocalModel).mockResolvedValue({ model_id: "small" });
  const refresh = vi.fn();
  const onFound = vi.fn();
  const onScan = vi.fn();
  render(
    <ModelLibrary
      disabled={false}
      onImported={refresh}
      onFound={onFound}
      onScan={onScan}
    />,
  );
  const select = await screen.findByLabelText("Models found on this PC");
  await userEvent.selectOptions(select, "C:/small.bin");
  expect(onFound).toHaveBeenCalledWith(["small"]);
  expect(select.textContent).not.toMatch(/model\.gguf/);
  // A file the speech engines cannot load is not offered anywhere.
  expect(screen.queryByText(/model\.gguf/)).toBeNull();
  expect(onScan).toHaveBeenCalledWith(
    expect.objectContaining({ truncated: true }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Verify and import small" }),
  );
  await screen.findByText(/Whisper model small verified and imported/);
  expect(refresh).toHaveBeenCalledOnce();
  expect(api.importLocalModel).toHaveBeenCalledWith("C:/small.bin");
  expect(screen.getByText(/Scan limit reached/)).toBeTruthy();

  vi.mocked(api.chooseModelFolder).mockResolvedValue("C:/custom");
  vi.mocked(api.scanLocalModels).mockResolvedValueOnce({
    models: [
      {
        path: "C:/custom/base.bin",
        format: "whisper",
        size: 456,
        model_id: "base",
      },
    ],
    folders: [{ path: "C:/custom", status: "scanned" }],
    truncated: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
  expect(api.scanLocalModels).toHaveBeenLastCalledWith("C:/custom");
  expect(onFound).toHaveBeenLastCalledWith(["base"]);
});
it("reports failed downloads and allows cancellation while a transfer is pending", async () => {
  const file = {
    repo_id: "public/model",
    revision: "abc",
    filename: "ggml-model.bin",
    size: 10,
    sha256: "123",
    license: "mit",
    model_id: null,
  };
  vi.mocked(api.searchHfModels).mockResolvedValue([
    { id: file.repo_id, license: "mit", kind: "whisper_ggml" },
  ]);
  vi.mocked(api.listHfFiles).mockResolvedValue({ files: [file], folders: [] });
  let reject: (error: Error) => void = () => {};
  vi.mocked(api.downloadHfModel).mockReturnValue(
    new Promise((_resolve, failure) => {
      reject = failure;
    }),
  );
  vi.mocked(api.cancelModelDownload).mockResolvedValue();
  render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "whisper");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Show files for public/model" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Download ggml-model.bin" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Cancel model download" }),
  );
  expect(api.cancelModelDownload).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("Download cancelled")));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("Download cancelled");
  expect(
    screen.getByRole("button", { name: "Download ggml-model.bin" }),
  ).toHaveProperty("disabled", false);
});

it("cancels an active transfer when Settings unmounts", async () => {
  vi.mocked(api.searchHfModels).mockResolvedValue([
    { id: "public/model", license: null, kind: "whisper_ggml" },
  ]);
  vi.mocked(api.listHfFiles).mockResolvedValue({
    files: [
      {
        repo_id: "public/model",
        revision: "abc",
        filename: "ggml-model.bin",
        size: 10,
        sha256: "123",
        license: null,
        model_id: null,
      },
    ],
    folders: [],
  });
  vi.mocked(api.downloadHfModel).mockReturnValue(new Promise(() => {}));
  vi.mocked(api.cancelModelDownload).mockResolvedValue();
  const view = render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "whisper");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Show files for public/model" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Download ggml-model.bin" }),
  );
  view.unmount();
  expect(api.cancelModelDownload).toHaveBeenCalledOnce();
});
it("shows why the automatic common-folder scan failed", async () => {
  vi.mocked(api.scanLocalModels).mockRejectedValue(
    new Error("The model folder could not be read."),
  );
  render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The model folder could not be read.",
  );
});

it("lists only downloadable speech results and saves a complete sherpa-onnx folder", async () => {
  const folder = {
    repo_id: "public/sherpa",
    revision: "abc",
    folder: "",
    layout: "transducer" as const,
    license: "apache-2.0",
    files: [
      {
        repo_id: "public/sherpa",
        revision: "abc",
        filename: "encoder.onnx",
        size: 10,
        sha256: "1",
        license: "apache-2.0",
        model_id: null,
      },
    ],
  };
  vi.mocked(api.searchHfModels).mockResolvedValue([
    { id: "public/sherpa", license: "apache-2.0", kind: "sherpa_onnx" },
    { id: "public/other", license: null, kind: "other" },
  ]);
  vi.mocked(api.listHfFiles).mockResolvedValue({
    files: [],
    folders: [folder],
  });
  vi.mocked(api.downloadHfFolder).mockResolvedValue({
    path: "C:/stt/sherpa/custom/public--sherpa",
    files: 1,
    model_id: "sherpa-dir:public--sherpa",
  });
  const onUse = vi.fn();
  render(<ModelLibrary disabled={false} onImported={vi.fn()} onUse={onUse} />);
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "speech");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  // A repository with no usable speech model is not listed at all.
  expect(screen.queryByText(/public\/other/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Show files for public/other" }),
  ).toBeNull();
  await userEvent.click(
    await screen.findByRole("button", { name: "Show files for public/sherpa" }),
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Download folder public/sherpa",
    }),
  );
  expect(api.downloadHfFolder).toHaveBeenCalledWith(folder);
  await screen.findByText(
    /Speech model folder downloaded and verified \(1 files\), saved to/,
  );
  await userEvent.click(screen.getByRole("button", { name: "Use this model" }));
  expect(onUse).toHaveBeenCalledWith("sherpa-dir:public--sherpa");
});

it("opens with a heading and one plain sentence, and explains the empty search", () => {
  render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Your own models" })).toBeTruthy();
  expect(
    screen.getByText(
      "Use a model file or folder you already have, or search Hugging Face.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Type a name to search.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Search" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("shows the reason next to disabled library actions", () => {
  render(<ModelLibrary disabled onImported={vi.fn()} />);
  expect(screen.getByText("Wait for the current task to finish.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Scan folders" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("keeps technical wording out of the first level", async () => {
  vi.mocked(api.searchHfModels).mockResolvedValue([
    { id: "public/model", license: "mit", kind: "whisper_ggml" },
  ]);
  vi.mocked(api.listHfFiles).mockResolvedValue({
    files: [
      {
        repo_id: "public/model",
        revision: "abc",
        filename: "ggml-model.bin",
        size: 10,
        sha256: "123",
        license: "mit",
        model_id: null,
      },
    ],
    folders: [],
  });
  render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "whisper");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Show files for public/model" }),
  );
  expect(screen.getByText("Speech model file", { exact: false })).toBeTruthy();
  expect(screen.queryByText(/Whisper ggml/)).toBeNull();
  expect(screen.getByText("Technical details")).toBeTruthy();
  expect(screen.queryByText(/Other \(not downloadable\)/)).toBeNull();
});
