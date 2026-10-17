import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { ModelLibrary } from "./ModelLibrary";
vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: {
    onModelLibraryProgress: vi.fn(),
    chooseModelFolder: vi.fn(),
    scanLocalModels: vi.fn(),
    importLocalModel: vi.fn(),
    searchHfModels: vi.fn(),
    listHfFiles: vi.fn(),
    downloadHfModel: vi.fn(),
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
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "gguf");
  expect(api.searchHfModels).not.toHaveBeenCalled();
  expect(api.scanLocalModels).toHaveBeenCalledOnce();
  expect(api.scanLocalModels).toHaveBeenCalledWith(null);
  await userEvent.click(
    screen.getByRole("button", { name: "Choose model folder" }),
  );
  expect(api.scanLocalModels).toHaveBeenCalledOnce();
});
it("imports only catalog candidates, shows external-server models separately, and updates found models on custom folder scan", async () => {
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
  render(
    <ModelLibrary disabled={false} onImported={refresh} onFound={onFound} />,
  );
  const select = await screen.findByLabelText("Found speech models");
  await userEvent.selectOptions(select, "C:/small.bin");
  expect(onFound).toHaveBeenCalledWith(["small"]);
  expect(select.textContent).not.toMatch(/model\.gguf/);
  expect(screen.getByText(/C:\/model\.gguf · gguf · 0\.0 MB/)).toBeTruthy();
  expect(
    screen.getByText(
      /Use with an external server\. Inference compatibility unverified\./,
    ),
  ).toBeTruthy();
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
  await userEvent.click(
    screen.getByRole("button", { name: "Choose model folder" }),
  );
  expect(api.scanLocalModels).toHaveBeenLastCalledWith("C:/custom");
  expect(onFound).toHaveBeenLastCalledWith(["base"]);
});
it("reports failed downloads and allows cancellation while a transfer is pending", async () => {
  const file = {
    repo_id: "public/model",
    revision: "abc",
    filename: "model.gguf",
    size: 10,
    sha256: "123",
    license: "mit",
    model_id: null,
  };
  vi.mocked(api.searchHfModels).mockResolvedValue([
    { id: file.repo_id, license: "mit" },
  ]);
  vi.mocked(api.listHfFiles).mockResolvedValue([file]);
  let reject: (error: Error) => void = () => {};
  vi.mocked(api.downloadHfModel).mockReturnValue(
    new Promise((_resolve, failure) => {
      reject = failure;
    }),
  );
  vi.mocked(api.cancelModelDownload).mockResolvedValue();
  render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "gguf");
  await userEvent.click(
    screen.getByRole("button", { name: "Search public models" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Show files for public/model" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Download model.gguf" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Cancel model download" }),
  );
  expect(api.cancelModelDownload).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("Download cancelled")));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("Download cancelled");
  expect(
    screen.getByRole("button", { name: "Download model.gguf" }),
  ).toHaveProperty("disabled", false);
});

it("cancels an active transfer when Settings unmounts", async () => {
  vi.mocked(api.searchHfModels).mockResolvedValue([
    { id: "public/model", license: null },
  ]);
  vi.mocked(api.listHfFiles).mockResolvedValue([
    {
      repo_id: "public/model",
      revision: "abc",
      filename: "model.gguf",
      size: 10,
      sha256: "123",
      license: null,
      model_id: null,
    },
  ]);
  vi.mocked(api.downloadHfModel).mockReturnValue(new Promise(() => {}));
  vi.mocked(api.cancelModelDownload).mockResolvedValue();
  const view = render(<ModelLibrary disabled={false} onImported={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Hugging Face search"), "gguf");
  await userEvent.click(
    screen.getByRole("button", { name: "Search public models" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Show files for public/model" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Download model.gguf" }),
  );
  view.unmount();
  expect(api.cancelModelDownload).toHaveBeenCalledOnce();
});
