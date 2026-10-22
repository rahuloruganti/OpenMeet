import { mockApiModule } from "./test/api-mock";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./lib/api";
import {
  initialSettings,
  ready,
  installDefaultMocks,
} from "./test/app-harness";

vi.mock("./lib/api", async (original) =>
  mockApiModule(await original<typeof import("./lib/api")>()),
);

beforeEach(installDefaultMocks);

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
    expect(api.exportMeeting).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
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
  });

  it("saves export options from Settings", async () => {
    vi.mocked(api.saveExportOptions).mockImplementation(async (options) => ({
      ...initialSettings,
      export: options,
    }));
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("tab", { name: "Export & storage" }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Include transcript" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: false,
      summary: true,
      filename: "title",
      transcript_formats: [],
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: "Include transcript",
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "File name" }),
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
    await userEvent.click(
      screen.getByRole("tab", { name: "Export & storage" }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Subtitles (.srt)" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["srt"],
    });
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Plain text (.txt)" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["srt", "txt"],
    });
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Subtitles (.srt)" }),
    );
    expect(api.saveExportOptions).toHaveBeenLastCalledWith({
      transcript: true,
      summary: true,
      filename: "title",
      transcript_formats: ["txt"],
    });
  });
});
