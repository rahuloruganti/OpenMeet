import { mockApiModule } from "./test/api-mock";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api, type MeetingDetail } from "./lib/api";
import {
  initialSettings,
  sample,
  ready,
  installDefaultMocks,
} from "./test/app-harness";

vi.mock("./lib/api", async (original) =>
  mockApiModule(await original<typeof import("./lib/api")>()),
);

beforeEach(installDefaultMocks);

describe("meeting library", () => {
  it("filters meeting navigation without replacing the selected draft", async () => {
    vi.mocked(api.listMeetings).mockResolvedValue([
      sample.meeting,
      { ...sample.meeting, id: "second", title: "Planning review" },
    ]);
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: /My notes/ }), {
      target: { value: "Still editing my notes" },
    });
    const search = screen.getByRole("searchbox", { name: "Search meetings" });
    await userEvent.type(search, "PLANNING");
    expect(screen.queryByRole("button", { name: /Sample sync/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Planning review/ }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Still editing my notes")).toBeTruthy();
    expect(api.getMeeting).toHaveBeenCalledOnce();
    await userEvent.clear(search);
    await userEvent.type(search, "no matching title");
    expect(screen.getByText("No matching meetings.")).toBeTruthy();
    expect(screen.getByDisplayValue("Still editing my notes")).toBeTruthy();
  });

  it("does not pretend the web preview can persist meetings", () => {
    vi.mocked(api.isDesktop).mockReturnValue(false);
    render(<App />);
    expect(screen.getByRole("alert").textContent).toContain(
      "browser preview cannot access",
    );
    expect(api.listMeetings).not.toHaveBeenCalled();
  });

  describe("notes-first polish", () => {
    const at = (days: number) => ({
      ...sample.meeting,

      id: `m${days}`,

      title: `Meeting ${days}`,

      started_at: new Date(
        new Date().getFullYear(),

        new Date().getMonth(),

        new Date().getDate() - days,

        12,
      ).toISOString(),
    });

    it("groups the sidebar by day and keeps search filtering inside groups", async () => {
      vi.mocked(api.listMeetings).mockResolvedValue([at(0), at(1), at(5)]);
      await ready();
      const sidebar = screen.getByRole("complementary", {
        name: "Meeting navigation",
      });
      const headings = Array.from(sidebar.querySelectorAll("h3")).map(
        (heading) => heading.textContent,
      );
      expect(headings).toEqual(["Today", "Yesterday", "Earlier"]);
      await userEvent.type(screen.getByRole("searchbox"), "Meeting 5");
      expect(
        Array.from(sidebar.querySelectorAll("h3")).map((h) => h.textContent),
      ).toEqual(["Earlier"]);
    });

    it("shows a first-note empty state without starting anything", async () => {
      vi.mocked(api.listMeetings).mockResolvedValue([]);
      render(<App />);
      await screen.findByText("Start your first note");
      expect(api.startCapture).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "Start simulation" }),
      ).toBeNull();
    });

    it("offers a disabled Enhance notes slot that explains why", async () => {
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
      const button = screen.getByRole("button", {
        name: "Enhance notes",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      const hint = document.getElementById(
        button.getAttribute("aria-describedby") ?? "",
      );
      expect(hint?.textContent).toContain("AI notes aren't set up yet");
      expect(screen.getByText("A fictional summary.")).toBeTruthy();
    });

    it("links an unassigned AI notes setup to its Settings section and returns focus", async () => {
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Open Settings for AI notes" }),
      );
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
      expect(
        screen
          .getByRole("tab", { name: "AI notes" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      await userEvent.click(
        screen.getByRole("button", { name: "Close panel" }),
      );
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Open Settings for AI notes" }),
      );
    });

    it("sends a remote AI notes connection without a key to Connections", async () => {
      vi.mocked(api.getSettings).mockResolvedValue({
        ...initialSettings,
        llm: {
          base_url: "https://provider.example/v1",
          model: "test-chat",
          revision: 1,
        },
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
      expect(
        within(screen.getByRole("tabpanel", { name: "Summary" })).getByText(
          "The AI notes connection needs an API key. Add it under Settings → Connections.",
        ),
      ).toBeTruthy();
      await userEvent.click(
        screen.getByRole("button", { name: "Open Settings for Connections" }),
      );
      expect(
        screen
          .getByRole("tab", { name: "Connections" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });

    it("does not ask for a key when AI notes uses a server on this computer", async () => {
      vi.mocked(api.getSettings).mockResolvedValue({
        ...initialSettings,
        llm: {
          base_url: "http://127.0.0.1:11434/v1",
          model: "test-chat",
          revision: 1,
        },
      });
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
      expect(
        (
          screen.getByRole("button", {
            name: "Enhance notes",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      expect(
        screen.queryByText(/needs an API key|aren't set up yet|Choose a model/),
      ).toBeNull();
    });

    it("disables Ask across meetings with the reason while AI notes is not set up", async () => {
      await ready();
      await userEvent.click(
        screen.getByRole("button", { name: "Ask across meetings" }),
      );
      await userEvent.click(screen.getByLabelText(/Sample sync/));
      await userEvent.type(screen.getByLabelText("Question"), "What moved?");
      const library = screen.getByRole("dialog", {
        name: "Ask across meetings",
      });
      expect(
        (
          within(library).getByRole("button", {
            name: "Ask",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        within(library).getByText(/AI notes aren't set up yet/),
      ).toBeTruthy();
      await userEvent.click(
        within(library).getByRole("button", {
          name: "Open Settings for AI notes",
        }),
      );
      expect(
        screen
          .getByRole("tab", { name: "AI notes" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });

    it("renames on Enter and restores the title on Escape", async () => {
      vi.mocked(api.renameMeeting).mockResolvedValue("Planning review");
      await ready();
      await userEvent.click(
        screen.getByRole("heading", { name: "Sample sync" }),
      );
      const input = screen.getByRole("textbox", { name: "Meeting title" });
      await userEvent.clear(input);
      await userEvent.type(input, "Discarded edit{Escape}");
      expect(screen.getByRole("heading", { name: "Sample sync" })).toBeTruthy();
      // Escape ends the edit and leaves focus on the title, not on the page body.
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Sample sync" }),
      );
      expect(api.renameMeeting).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Rename" }));
      const again = screen.getByRole("textbox", { name: "Meeting title" });
      expect((again as HTMLInputElement).value).toBe("Sample sync");
      await userEvent.clear(again);
      await userEvent.type(again, "  Planning review {Enter}");
      expect(api.renameMeeting).toHaveBeenCalledWith(
        "sample",
        "  Planning review ",
      );
      expect(api.renameMeeting).toHaveBeenCalledOnce();
      const renamed = await screen.findByRole("heading", {
        name: "Planning review",
      });
      expect(renamed).toBeTruthy();
      expect(document.activeElement).toBe(renamed);
      expect(screen.getByDisplayValue("Original notes")).toBeTruthy();
    });

    it("saves a typed title once when the field loses focus, and Escape never saves", async () => {
      vi.mocked(api.renameMeeting).mockResolvedValue("Blurred title");
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "Rename" }));
      const input = screen.getByRole("textbox", { name: "Meeting title" });
      await userEvent.clear(input);
      await userEvent.type(input, "Blurred title");
      await userEvent.tab();
      const blurred = await screen.findByRole("heading", {
        name: "Blurred title",
      });
      expect(blurred).toBeTruthy();
      // Leaving the field by clicking or tabbing away keeps the user's focus where they put it.
      expect(document.activeElement).not.toBe(blurred);
      expect(api.renameMeeting).toHaveBeenCalledOnce();
      expect(api.renameMeeting).toHaveBeenCalledWith("sample", "Blurred title");
      await userEvent.click(screen.getByRole("button", { name: "Rename" }));
      await userEvent.clear(
        screen.getByRole("textbox", { name: "Meeting title" }),
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: "Meeting title" }),
        "Escaped title{Escape}",
      );
      expect(api.renameMeeting).toHaveBeenCalledOnce();
    });

    it("keeps the old title and shows the error when a rename is rejected", async () => {
      vi.mocked(api.renameMeeting).mockRejectedValue({
        code: "invalid_title",
        message: "Use a meeting title between 1 and 160 characters.",
      });
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "Rename" }));
      await userEvent.clear(
        screen.getByRole("textbox", { name: "Meeting title" }),
      );
      await userEvent.keyboard("{Enter}");
      await screen.findByText(/between 1 and 160 characters/);
      expect(screen.getByRole("heading", { name: "Sample sync" })).toBeTruthy();
    });
  });

  describe("meeting library", () => {
    const note: MeetingDetail = {
      ...sample,

      meeting: {
        ...sample.meeting,

        id: "note",

        title: "Untitled note",

        source: "note",
      },

      user_markdown: "",

      summary: null,

      summary_provider: null,

      summary_model: null,
    };

    it("creates a notes-only meeting without touching recording", async () => {
      await ready();
      vi.mocked(api.createNote).mockResolvedValue("note");
      vi.mocked(api.listMeetings).mockResolvedValue([
        note.meeting,
        sample.meeting,
      ]);
      vi.mocked(api.getMeeting).mockResolvedValue(note);
      await userEvent.click(screen.getByRole("button", { name: "New note" }));
      await screen.findByRole("heading", { name: "Untitled note" });
      expect(api.createNote).toHaveBeenCalledWith("Untitled note");
      expect(
        screen.queryByRole("button", { name: "Start simulation" }),
      ).toBeNull();
      expect(api.startCapture).not.toHaveBeenCalled();
      expect(
        screen.getByText("Note", { selector: ".source-badge" }),
      ).toBeTruthy();
      await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
      expect(
        screen.getByText("No transcript. Notes have no recorded audio."),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Transcribe/ })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Delete audio…" }),
      ).toBeNull();
    });

    it("deletes a meeting only after its exact title is typed", async () => {
      await ready();
      await userEvent.click(screen.getByLabelText("More meeting actions"));
      await userEvent.click(
        screen.getByRole("button", { name: "Delete meeting…" }),
      );
      const confirm = screen.getByRole("button", {
        name: "Delete meeting",
      }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      expect(
        screen.getByText(/Exported Markdown snapshots are not touched/),
      ).toBeTruthy();
      const input = screen.getByRole("textbox", {
        name: "Type the meeting title to confirm",
      });
      await userEvent.type(input, "Sample syn");
      expect(confirm.disabled).toBe(true);
      await userEvent.type(input, "c");
      expect(confirm.disabled).toBe(false);
      vi.mocked(api.listMeetings).mockResolvedValue([]);
      vi.mocked(api.deleteMeeting).mockResolvedValue();
      await userEvent.click(confirm);
      await screen.findByText(/Meeting deleted from this device/);
      expect(api.deleteMeeting).toHaveBeenCalledWith("sample");
      expect(api.deleteAudio).not.toHaveBeenCalled();
      expect(screen.queryByDisplayValue("Original notes")).toBeNull();
    });

    it("deletes an empty note with one confirmation and no typed title", async () => {
      vi.mocked(api.listMeetings).mockResolvedValue([note.meeting]);
      vi.mocked(api.getMeeting).mockResolvedValue(note);
      render(<App />);
      await screen.findByRole("heading", { name: "Untitled note" });
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Save notes now",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      await userEvent.click(screen.getByLabelText("More meeting actions"));
      await userEvent.click(
        screen.getByRole("button", { name: "Delete meeting…" }),
      );
      expect(
        screen.getByText(/Permanently delete “Untitled note”/),
      ).toBeTruthy();
      expect(screen.getByText(/This cannot be undone/)).toBeTruthy();
      expect(
        screen.queryByRole("textbox", {
          name: "Type the meeting title to confirm",
        }),
      ).toBeNull();
      const confirm = screen.getByRole("button", {
        name: "Delete meeting",
      }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(false);
      vi.mocked(api.listMeetings).mockResolvedValue([]);
      vi.mocked(api.deleteMeeting).mockResolvedValue();
      await userEvent.click(confirm);
      await screen.findByText(/Meeting deleted from this device/);
      expect(api.deleteMeeting).toHaveBeenCalledOnce();
      expect(api.deleteMeeting).toHaveBeenCalledWith("note");
    });

    it("still requires the typed title to delete a note that has text", async () => {
      vi.mocked(api.listMeetings).mockResolvedValue([note.meeting]);
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...note,
        user_markdown: "Keep this",
      });
      render(<App />);
      await screen.findByDisplayValue("Keep this");
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Save notes now",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      await userEvent.click(screen.getByLabelText("More meeting actions"));
      await userEvent.click(
        screen.getByRole("button", { name: "Delete meeting…" }),
      );
      const confirm = screen.getByRole("button", {
        name: "Delete meeting",
      }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      await userEvent.type(
        screen.getByRole("textbox", {
          name: "Type the meeting title to confirm",
        }),
        "Untitled note",
      );
      expect(confirm.disabled).toBe(false);
    });

    it("refuses deletion controls for the meeting being recorded", async () => {
      vi.mocked(api.getRecordingState).mockResolvedValue({
        revision: 1,
        status: "recording",
        meeting_id: "sample",
        source: "simulation",
        error: null,
        recording_offset_ms: null,
      });
      await ready();
      expect(
        (
          screen.getByRole("button", {
            name: "Delete meeting…",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });

    it("closes the ••• menu on Escape and returns focus to its summary", async () => {
      await ready();
      const summary = screen.getByLabelText("More meeting actions");
      await userEvent.click(summary);
      expect((summary.closest("details") as HTMLDetailsElement).open).toBe(
        true,
      );
      await userEvent.keyboard("{Escape}");
      expect((summary.closest("details") as HTMLDetailsElement).open).toBe(
        false,
      );
      expect(document.activeElement).toBe(summary);
    });

    it("moves focus into the delete card and returns it to the ••• menu on Escape or Cancel", async () => {
      await ready();
      await userEvent.click(screen.getByLabelText("More meeting actions"));
      await userEvent.click(
        screen.getByRole("button", { name: "Delete meeting…" }),
      );
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", {
          name: "Type the meeting title to confirm",
        }),
      );
      await userEvent.keyboard("{Escape}");
      expect(
        screen.queryByRole("group", { name: "Confirm meeting deletion" }),
      ).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByLabelText("More meeting actions"),
      );
      await userEvent.click(screen.getByLabelText("More meeting actions"));
      await userEvent.click(
        screen.getByRole("button", { name: "Delete meeting…" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(
        screen.queryByRole("group", { name: "Confirm meeting deletion" }),
      ).toBeNull();
      expect(api.deleteMeeting).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(
        screen.getByLabelText("More meeting actions"),
      );
    });

    it("focuses Cancel, never the delete button, when an empty note needs no title", async () => {
      vi.mocked(api.listMeetings).mockResolvedValue([note.meeting]);
      vi.mocked(api.getMeeting).mockResolvedValue(note);
      render(<App />);
      await screen.findByRole("heading", { name: "Untitled note" });
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Save notes now",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      await userEvent.click(screen.getByLabelText("More meeting actions"));
      await userEvent.click(
        screen.getByRole("button", { name: "Delete meeting…" }),
      );
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Cancel" }),
      );
    });

    it("shows full-text matches and opens the meeting on the matching tab", async () => {
      const second = {
        ...sample.meeting,
        id: "second",
        title: "Planning review",
      };
      vi.mocked(api.listMeetings).mockResolvedValue([sample.meeting, second]);
      vi.mocked(api.searchMeetings).mockResolvedValue([
        {
          meeting_id: "second",
          kind: "transcript",
          snippet: "roadmap slipped",
        },
        { meeting_id: "second", kind: "title", snippet: "Planning review" },
      ]);
      await ready();
      await userEvent.type(
        screen.getByRole("searchbox", { name: "Search meetings" }),
        "roadmap",
      );
      const hit = await screen.findByRole("button", {
        name: /roadmap slipped/,
      });
      expect(api.searchMeetings).toHaveBeenLastCalledWith("roadmap");
      expect(api.searchMeetings).not.toHaveBeenCalledWith("r");
      expect(screen.queryByText("No matching meetings.")).toBeNull();
      vi.mocked(api.getMeeting).mockResolvedValue({
        ...sample,
        meeting: second,
      });
      await userEvent.click(hit);
      await waitFor(() =>
        expect(
          screen
            .getByRole("tab", { name: "Transcript" })
            .getAttribute("aria-selected"),
        ).toBe("true"),
      );
      expect(api.getMeeting).toHaveBeenLastCalledWith("second");
    });
  });
});
