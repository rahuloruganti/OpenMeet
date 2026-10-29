import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Folder, type Meeting } from "../../shared/api/api";
import { formatShortDate, formatTime } from "../../entities/meeting";
import { MeetingSidebar } from "./MeetingSidebar";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    reorderFolders: vi.fn(),
  },
}));

const at = (date: Date): string => date.toISOString();
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30);
const earlier = new Date(
  now.getFullYear(),
  now.getMonth(),
  now.getDate() - 5,
  9,
  30,
);

const make = (
  id: string,
  title: string,
  started: Date,
  tags: string[] = [],
  folderId: string | null = null,
): Meeting => ({
  id,
  title,
  started_at: at(started),
  ended_at: null,
  status: "stopped",
  source: "desktop",
  capture_error: null,
  calendar_event_id: null,
  tags,
  folder_id: folderId,
});

function sidebar(meetings: Meeting[], search = "") {
  render(
    <MeetingSidebar
      open
      meetings={meetings}
      search={search}
      selectedId={undefined}
      disabled={false}
      recordingActive={false}
      onSearch={vi.fn()}
      onNewRecording={vi.fn()}
      onSettings={vi.fn()}
      onOpenMeeting={vi.fn()}
      onNewNote={vi.fn()}
      hits={[]}
      onOpenHit={vi.fn()}
      audioBytes={null}
    />,
  );
}

const row = (name: RegExp) => screen.getByRole("button", { name });

afterEach(() => vi.restoreAllMocks());

describe("meeting sidebar", () => {
  it.each(["Windows", "Macintosh"])(
    "does not advertise the palette shortcut in search on %s",
    (platform) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
      sidebar([]);
      const search = screen.getByRole("searchbox", { name: "Search meetings" });
      expect(search.closest(".sb-search")?.querySelector("kbd")).toBeNull();
      expect(search.getAttribute("aria-keyshortcuts")).toBeNull();
    },
  );
  it("filters with folded text in either direction", () => {
    sidebar(
      [
        make("cafe", "Café review", today),
        make("ang", "Ångström sync", earlier),
        make("b", "Budget", earlier),
      ],
      "cafe",
    );
    expect(screen.queryByRole("button", { name: /Ångström/ })).toBeNull();
    expect(row(/Café review/)).toBeTruthy();
  });

  it("filters with a folded search written without accents", () => {
    sidebar(
      [make("ang", "Ångström sync", earlier), make("b", "Budget", earlier)],
      "angstrom",
    );
    expect(row(/Ångström sync/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Budget/ })).toBeNull();
  });

  it("shows start times for Today and Yesterday and dates for earlier meetings", () => {
    sidebar([make("t", "Standup", today), make("e", "Retro", earlier)]);
    const todayRow = within(row(/Standup/));
    expect(todayRow.getByText(formatTime(at(today)))).toBeTruthy();
    const earlierRow = within(row(/Retro/));
    expect(earlierRow.getByText(formatShortDate(at(earlier)))).toBeTruthy();
  });

  it("keeps two same-day, same-title meetings distinguishable by start time", () => {
    const morning = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      8,
      5,
    );
    const afternoon = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      15,
      45,
    );
    sidebar([make("a", "Sync", morning), make("b", "Sync", afternoon)]);
    const rows = screen.getAllByRole("button", { name: /Sync/ });
    expect(rows[0].querySelector("time")?.textContent).toBe(
      formatTime(at(morning)),
    );
    expect(rows[1].querySelector("time")?.textContent).toBe(
      formatTime(at(afternoon)),
    );
    expect(rows[0].querySelector("time")?.textContent).not.toBe(
      rows[1].querySelector("time")?.textContent,
    );
  });

  it("shows at most three tags with a count, and the full list in a title", () => {
    sidebar([
      make("tags", "Planning", today, [
        "Alpha",
        "Beta",
        "Gamma",
        "Delta",
        "Epsilon",
      ]),
    ]);
    const meta = row(/Planning/).querySelector(".meeting-tags") as HTMLElement;
    expect(meta.textContent).toBe(" · Alpha, Beta, Gamma +2");
    expect(meta.getAttribute("title")).toBe(
      "Alpha, Beta, Gamma, Delta, Epsilon",
    );
  });

  it("shows all tags without a count when there are three or fewer", () => {
    sidebar([make("tags", "Planning", today, ["Alpha", "Beta"])]);
    const meta = row(/Planning/).querySelector(".meeting-tags") as HTMLElement;
    expect(meta.textContent).toBe(" · Alpha, Beta");
    expect(meta.getAttribute("title")).toBe("Alpha, Beta");
  });
});

describe("meeting sidebar folders", () => {
  const folders: Folder[] = [
    { id: "f1", name: "Client work", position: 0, meeting_count: 2 },
    { id: "f2", name: "Empty", position: 1, meeting_count: 0 },
  ];
  const filed = [
    make("a", "Alpha sync", today, [], "f1"),
    make("b", "Beta review", today, []),
    make("c", "Gamma plan", earlier, [], "f1"),
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.listFolders).mockResolvedValue(folders);
  });

  it("groups meetings under their folder, then No folder last", async () => {
    sidebar(filed);
    await screen.findByRole("region", { name: "Client work" });
    const regions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"))
      .filter((label) =>
        ["Client work", "Empty", "No folder"].includes(label ?? ""),
      );
    expect(regions).toEqual(["Client work", "Empty", "No folder"]);
    const client = screen.getByRole("region", { name: "Client work" });
    expect(
      within(client).getByRole("button", { name: /Alpha sync/ }),
    ).toBeTruthy();
    expect(
      within(client).getByRole("button", { name: /Gamma plan/ }),
    ).toBeTruthy();
    const none = screen.getByRole("region", { name: "No folder" });
    expect(
      within(none).getByRole("button", { name: /Beta review/ }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Empty" })).getByText(
        "No meetings",
      ),
    ).toBeTruthy();
  });

  it("collapses a folder section without changing its meetings", async () => {
    sidebar(filed);
    const toggle = await screen.findByRole("button", { name: /^Client work/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Alpha sync/ })).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: /Alpha sync/ })).toBeTruthy();
  });

  it("keeps search working across folder groups and hides empty ones", async () => {
    sidebar(filed, "gamma");
    await screen.findByRole("region", { name: "Client work" });
    expect(screen.getByRole("button", { name: /Gamma plan/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Empty" })).toBeNull();
    expect(screen.queryByRole("region", { name: "No folder" })).toBeNull();
  });

  it("opens the folder manager and creates a folder from it", async () => {
    vi.mocked(api.createFolder).mockResolvedValue(folders);
    sidebar(filed);
    await userEvent.click(
      await screen.findByRole("button", { name: "Folders" }),
    );
    const manager = screen.getByRole("region", { name: "Folders" });
    await userEvent.type(within(manager).getByLabelText("New folder"), "Ops");
    await userEvent.click(
      within(manager).getByRole("button", { name: "Add folder" }),
    );
    expect(api.createFolder).toHaveBeenCalledWith("Ops");
  });

  it("asks once, inline, before deleting a folder", async () => {
    const confirm = vi.spyOn(window, "confirm");
    vi.mocked(api.deleteFolder).mockResolvedValue([folders[1]]);
    sidebar(filed);
    await userEvent.click(
      await screen.findByRole("button", { name: "Folders" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete Client work" }),
    );
    expect(screen.getByText(/Its meetings stay/)).toBeTruthy();
    expect(api.deleteFolder).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Delete folder" }),
    );
    expect(api.deleteFolder).toHaveBeenCalledWith("f1");
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
