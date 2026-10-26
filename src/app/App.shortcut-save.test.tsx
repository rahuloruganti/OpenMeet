import { mockApiModule } from "../shared/test/api-mock";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../shared/api/api";
import {
  installDefaultMocks,
  ready,
  settingsIndex,
} from "../shared/test/app-harness";

vi.mock("../shared/api/api", async (original) =>
  mockApiModule(await original<typeof import("../shared/api/api")>()),
);

beforeEach(installDefaultMocks);

describe("a shortcut the backend refuses", () => {
  it("is explained in the Shortcuts group, where the change was made", async () => {
    const refusal =
      "This shortcut could not be registered. Choose another combination.";
    // The transport rejects with the backend's {code, message} body.
    vi.mocked(api.saveSettings).mockRejectedValue({
      code: "shortcut_unavailable",
      message: refusal,
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(settingsIndex("Recording"));
    const capture = screen.getByRole("button", {
      name: "Change pause / resume shortcut",
    });
    await userEvent.click(capture);
    fireEvent.keyDown(capture, {
      key: "F9",
      code: "F9",
      ctrlKey: true,
      altKey: true,
    });
    const shortcuts = within(screen.getByRole("region", { name: "Shortcuts" }));
    expect(await shortcuts.findByText(refusal)).toBeTruthy();
    expect(vi.mocked(api.saveSettings).mock.calls[0]?.[0]).toBe(
      "CommandOrControl+Alt+F9",
    );
    // The pause chord is unchanged, and the key caps still show the saved value.
    expect(screen.getByLabelText("Pause / resume shortcut").textContent).toBe(
      "CtrlShiftSpace",
    );
  });
});
