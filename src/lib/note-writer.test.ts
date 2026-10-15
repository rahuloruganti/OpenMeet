import { describe, expect, it, vi } from "vitest";
import { createNoteWriter } from "./note-writer";

describe("note writer", () => {
  it("serializes in-flight writes and flushes the newest text", async () => {
    let finishFirst!: (revision: number) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(2);
    const writer = createNoteWriter("", 0, save, vi.fn());
    writer.update("first");
    const saving = writer.flush();
    writer.update("second");
    expect(save).toHaveBeenCalledTimes(1);
    finishFirst(1);
    await saving;
    expect(save.mock.calls).toEqual([
      ["first", 0],
      ["second", 1],
    ]);
    expect(writer.isDirty()).toBe(false);
    writer.dispose();
  });

  it("preserves dirty text on failure and retries with the last saved revision", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(8);
    const status = vi.fn();
    const writer = createNoteWriter("old", 7, save, status);
    writer.update("new");
    await expect(writer.flush()).rejects.toThrow("disk full");
    expect(writer.isDirty()).toBe(true);
    expect(writer.persistedRevision()).toBe(7);
    expect(status).toHaveBeenCalledWith("error", expect.any(Error));
    await writer.flush();
    expect(save.mock.calls).toEqual([
      ["new", 7],
      ["new", 7],
    ]);
    expect(writer.isDirty()).toBe(false);
    expect(writer.persistedRevision()).toBe(8);
    writer.dispose();
  });

  it("does not write unchanged notes", async () => {
    const save = vi.fn();
    const writer = createNoteWriter("unchanged", 2, save, vi.fn());
    await writer.flush();
    expect(save).not.toHaveBeenCalled();
    writer.dispose();
  });
});
