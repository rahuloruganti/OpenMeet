import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type Settings } from "../../shared/api/api";
import { SummaryTemplates } from "./SummaryTemplates";
vi.mock("../../shared/api/api", async (original) => ({
  ...(await original<typeof import("../../shared/api/api")>()),
  api: {
    saveSummaryInstructions: vi.fn(),
    saveSummaryTemplate: vi.fn(),
    deleteSummaryTemplate: vi.fn(),
  },
}));
const settings = {
  summary_instructions: "",
  summary_templates: [
    { id: "custom-retro", name: "Retro", instructions: "## Went well" },
  ],
} as unknown as Settings;
beforeEach(() => vi.resetAllMocks());

it("adds, edits and deletes templates and keeps a failed save's draft", async () => {
  const onSettings = vi.fn();
  vi.mocked(api.saveSummaryTemplate).mockResolvedValue(settings);
  vi.mocked(api.deleteSummaryTemplate).mockResolvedValue(settings);
  vi.mocked(api.saveSummaryInstructions).mockRejectedValue({
    code: "summary_instructions",
    message: "Use at most 2000 characters without control characters.",
  });
  render(
    <SummaryTemplates
      settings={settings}
      disabled={false}
      onSettings={onSettings}
    />,
  );
  const add = screen.getByRole("button", { name: "Add template" });
  expect((add as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("Template name"), "Board");
  await userEvent.type(screen.getByLabelText("Template structure"), "## Risks");
  await userEvent.click(add);
  expect(api.saveSummaryTemplate).toHaveBeenCalledWith(
    null,
    "Board",
    "## Risks",
  );
  expect(onSettings).toHaveBeenCalledWith(settings);
  await userEvent.selectOptions(
    screen.getByLabelText("Custom template"),
    "Retro",
  );
  expect(screen.getByDisplayValue("## Went well")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save template" }));
  expect(api.saveSummaryTemplate).toHaveBeenLastCalledWith(
    "custom-retro",
    "Retro",
    "## Went well",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Delete template" }),
  );
  expect(api.deleteSummaryTemplate).toHaveBeenCalledWith("custom-retro");
  await userEvent.type(
    screen.getByLabelText("Saved summary instructions"),
    "Be brief.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save instructions" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByDisplayValue("Be brief.")).toBeTruthy();
});
