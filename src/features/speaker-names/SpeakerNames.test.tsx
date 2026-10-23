import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, speakerLabel } from "../../shared/api/api";
import { SpeakerNamesForm } from "./SpeakerNames";
vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: { saveSpeakerNames: vi.fn() },
}));
beforeEach(() => vi.resetAllMocks());

it("saves names, discloses what Others covers, and keeps input on failure", async () => {
  const onNames = vi.fn();
  vi.mocked(api.saveSpeakerNames)
    .mockRejectedValueOnce({
      code: "speaker_name",
      message: "Keep each speaker name on one line, at most 80 characters.",
    })
    .mockResolvedValue({ you: "Rahul", others: null });
  render(
    <SpeakerNamesForm
      meetingId="m1"
      names={{ you: null, others: null }}
      disabled={false}
      onNames={onNames}
    />,
  );
  expect(screen.getByText(/may include several people/)).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save speaker names" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(
    screen.getByLabelText("Name for You (microphone)"),
    "Rahul",
  );
  await userEvent.click(save);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByDisplayValue("Rahul")).toBeTruthy();
  await userEvent.click(save);
  expect(api.saveSpeakerNames).toHaveBeenLastCalledWith("m1", "Rahul", null);
  expect(onNames).toHaveBeenCalledWith({ you: "Rahul", others: null });
  expect(speakerLabel({ you: "Rahul", others: null }, "You")).toBe(
    "Rahul (You)",
  );
  expect(speakerLabel({ you: "Rahul", others: null }, "Others")).toBe("Others");
});
