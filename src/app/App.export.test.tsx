import { mockApiModule } from "../shared/test/api-mock";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Settings } from "../shared/api/api";
import {
  initialSettings,
  settingsIndex,
  ready,
  installDefaultMocks,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

/** One Settings section; every section renders at once, so queries must be scoped. */
function settingsSection(name: string) {
  return within(screen.getByRole("region", { name }));
}

describe("export", () => {
  it("flushes typed notes before export", async () => {
    await ready();
    vi.mocked(api.exportMeeting).mockResolvedValue({
      path: "C:/notes/sample.md",
      created_copy: false,
      transcript_paths: [],
    });
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Unsaved edits" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await waitFor(() =>
      expect(api.exportMeeting).toHaveBeenCalledWith("sample"),
    );
    expect(api.saveNotes).toHaveBeenCalledWith("sample", "Unsaved edits", 0);
    expect(vi.mocked(api.saveNotes).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.exportMeeting).mock.invocationCallOrder[0],
    );
  });

  it("cancels the first export cleanly when no folder is chosen", async () => {
    vi.mocked(api.chooseVaultFolder).mockResolvedValue(initialSettings);
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await waitFor(() => expect(api.chooseVaultFolder).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Export Markdown",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(api.exportMeeting).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
    expect(
      screen.getByText(/Choose a folder for exported Markdown files/),
    ).toBeTruthy();
  });

  it("explains the first folder choice, then shows the export result", async () => {
    let pickFolder: (value: Settings) => void = () => {};
    vi.mocked(api.chooseVaultFolder).mockReturnValue(
      new Promise<Settings>((resolve) => {
        pickFolder = resolve;
      }),
    );
    vi.mocked(api.exportMeeting).mockResolvedValue({
      path: "C:/notes/sample.md",
      created_copy: false,
      transcript_paths: [],
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await waitFor(() => expect(api.chooseVaultFolder).toHaveBeenCalledOnce());
    expect(
      screen.getByText(/Choose a folder for exported Markdown files/),
    ).toBeTruthy();
    await act(async () =>
      pickFolder({ ...initialSettings, vault_folder: "C:/notes" }),
    );
    await screen.findByText("Exported: C:/notes/sample.md");
    expect(screen.queryByText(/Choose a folder for exported/)).toBeNull();
  });

  it("keeps the notes box read-only, not disabled, while the folder picker is open", async () => {
    let pickFolder: (value: Settings) => void = () => {};
    vi.mocked(api.chooseVaultFolder).mockReturnValue(
      new Promise<Settings>((resolve) => {
        pickFolder = resolve;
      }),
    );
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await waitFor(() => expect(api.chooseVaultFolder).toHaveBeenCalledOnce());
    const notes = screen.getByRole("textbox", {
      name: /My notes/,
    }) as HTMLTextAreaElement;
    expect(notes.readOnly).toBe(true);
    expect(notes.disabled).toBe(false);
    await act(async () => pickFolder(initialSettings));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: /My notes/,
          }) as HTMLTextAreaElement
        ).readOnly,
      ).toBe(false),
    );
  });

  it("uses an existing export folder without asking again", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...initialSettings,
      vault_folder: "C:/notes",
    });
    vi.mocked(api.exportMeeting).mockResolvedValue({
      path: "C:/notes/sample.md",
      created_copy: false,
      transcript_paths: [],
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Export Markdown" }),
    );
    await screen.findByText("Exported: C:/notes/sample.md");
    expect(api.chooseVaultFolder).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByText("Exported: C:/notes/sample.md")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("saves export options from Settings", async () => {
    vi.mocked(api.saveExportOptions).mockImplementation(async (options) => ({
      ...initialSettings,
      export: options,
    }));
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Export & storage"));
    const exporting = settingsSection("Export & storage");
    await userEvent.click(
      exporting.getByRole("switch", { name: "Include transcript" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: false,
      summary: true,
      filename: "title",
      transcript_formats: [],
    });
    await waitFor(() =>
      expect(
        exporting
          .getByRole("switch", { name: "Include transcript" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    await userEvent.selectOptions(
      exporting.getByRole("combobox", { name: "File name" }),
      "date_title",
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: false,
      summary: true,
      filename: "date_title",
      transcript_formats: [],
    });
  });

  it("saves transcript file formats and reports them after an export", async () => {
    vi.mocked(api.saveExportOptions).mockImplementation(async (options) => ({
      ...initialSettings,
      export: options,
    }));
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Export & storage"));
    const exporting = settingsSection("Export & storage");
    await userEvent.click(exporting.getByRole("button", { name: "SRT" }));
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["srt"],
    });
    await userEvent.click(exporting.getByRole("button", { name: "TXT" }));
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["srt", "txt"],
    });
    await userEvent.click(exporting.getByRole("button", { name: "SRT" }));
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["txt"],
    });
    // The chosen formats stay pressed, so the state is visible after saving.
    expect(
      exporting
        .getByRole("button", { name: "TXT" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      exporting
        .getByRole("button", { name: "SRT" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
