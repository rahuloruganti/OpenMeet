import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Folder, type Meeting } from "../../shared/api/api";
import { FolderManager } from "./FolderManager";
import { FolderPicker } from "./FolderPicker";
import { MoveToFolder } from "./MoveToFolder";

vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    reorderFolders: vi.fn(),
    moveMeetingToFolder: vi.fn(),
  },
}));

const folders: Folder[] = [
  { id: "f1", name: "Client work", position: 0, meeting_count: 2 },
  { id: "f2", name: "Ops", position: 1, meeting_count: 0 },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listFolders).mockResolvedValue(folders);
});

describe("FolderPicker", () => {
  it("offers No folder first and New folder last", () => {
    render(
      <FolderPicker
        label="Folder"
        folders={folders}
        value={null}
        disabled={false}
        onChoose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["No folder", "Client work", "Ops", "New folder"]);
  });

  it("reveals a name field for New folder and creates then chooses it", async () => {
    const onChoose = vi.fn();
    const onCreated = vi.fn();
    vi.mocked(api.createFolder).mockResolvedValue([
      ...folders,
      { id: "f3", name: "Sales", position: 2, meeting_count: 0 },
    ]);
    render(
      <FolderPicker
        label="Folder"
        folders={folders}
        value={null}
        disabled={false}
        onChoose={onChoose}
        onCreated={onCreated}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Folder"), "__new__");
    await userEvent.type(screen.getByLabelText("Folder name"), "  Sales  ");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(api.createFolder).toHaveBeenCalledWith("Sales");
    expect(onCreated).toHaveBeenCalled();
    expect(onChoose).toHaveBeenCalledWith("f3");
  });

  it("shows the error and keeps the field when creating fails", async () => {
    vi.mocked(api.createFolder).mockRejectedValue(
      new Error("A folder has this name."),
    );
    render(
      <FolderPicker
        label="Folder"
        folders={folders}
        value={null}
        disabled={false}
        onChoose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Folder"), "__new__");
    await userEvent.type(screen.getByLabelText("Folder name"), "Ops");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A folder has this name.",
    );
    expect(screen.getByLabelText("Folder name")).toBeTruthy();
  });
});

describe("MoveToFolder", () => {
  const moved = (folderId: string | null): Meeting => ({
    id: "m1",
    title: "Alpha",
    started_at: "2026-10-09T10:00:00Z",
    ended_at: null,
    status: "stopped",
    source: "desktop",
    capture_error: null,
    tags: [],
    calendar_event_id: null,
    folder_id: folderId,
  });

  it("files the meeting into a chosen folder and clears it on No folder", async () => {
    const onMoved = vi.fn();
    vi.mocked(api.moveMeetingToFolder).mockImplementation(async (_id, folder) =>
      moved(folder),
    );
    render(
      <MoveToFolder
        meetingId="m1"
        folderId="f1"
        disabled={false}
        onMoved={onMoved}
      />,
    );
    const select = await screen.findByLabelText("Move to folder");
    await userEvent.selectOptions(select, "f2");
    expect(api.moveMeetingToFolder).toHaveBeenLastCalledWith("m1", "f2");
    await userEvent.selectOptions(select, "");
    expect(api.moveMeetingToFolder).toHaveBeenLastCalledWith("m1", null);
    expect(onMoved).toHaveBeenCalledTimes(2);
  });
});

describe("FolderManager", () => {
  const renders = (onChanged = vi.fn()) => {
    render(
      <FolderManager
        folders={folders}
        disabled={false}
        onChanged={onChanged}
      />,
    );
    return onChanged;
  };

  it("swaps two folders with the down button and saves the new order", async () => {
    vi.mocked(api.reorderFolders).mockResolvedValue([folders[1], folders[0]]);
    const onChanged = renders();
    await userEvent.click(
      screen.getByRole("button", { name: "Move Client work down" }),
    );
    expect(api.reorderFolders).toHaveBeenCalledWith(["f2", "f1"]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("renames a folder inline", async () => {
    vi.mocked(api.renameFolder).mockResolvedValue(folders);
    renders();
    const row = screen
      .getByRole("list", { name: "Folder order" })
      .querySelector("li");
    await userEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Rename" }),
    );
    const field = screen.getByLabelText("Rename Client work");
    await userEvent.clear(field);
    await userEvent.type(field, "Clients");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.renameFolder).toHaveBeenCalledWith("f1", "Clients");
  });

  it("asks once inline before deleting and keeps the folder on Keep", async () => {
    vi.mocked(api.deleteFolder).mockResolvedValue([folders[1]]);
    renders();
    await userEvent.click(screen.getByRole("button", { name: "Delete Ops" }));
    expect(screen.getByText(/Its meetings stay/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(api.deleteFolder).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete Ops" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Delete folder" }),
    );
    expect(api.deleteFolder).toHaveBeenCalledWith("f2");
  });

  it("shows the refusal when a folder with a recording cannot be deleted", async () => {
    vi.mocked(api.deleteFolder).mockRejectedValue(
      new Error("Stop the recording first."),
    );
    renders();
    await userEvent.click(screen.getByRole("button", { name: "Delete Ops" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Delete folder" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Stop the recording first.",
    );
  });
});
