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
  summary_default: "general-v1",
  summary_templates: [
    { id: "custom-retro", name: "Retro", instructions: "## Went well" },
  ],
  recipes: [{ id: "recipe-1", name: "Risks", prompt: "Which risks?" }],
} as unknown as Settings;
const props = (input: Settings = settings) => ({
  settings: input,
  disabled: false,
  onSettings: vi.fn(),
  onDefaultTemplate: vi.fn(),
});
beforeEach(() => vi.resetAllMocks());

it("offers summary templates only: no recipes and no kind choice, since Ask is gone", async () => {
  const input = props();
  render(<SummaryTemplates {...input} />);
  expect(screen.getByRole("button", { name: "Edit Retro" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit Risks" })).toBeNull();
  expect(screen.queryByText("Recipe")).toBeNull();
  expect(screen.getByText("1 saved")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "New template" }));
  expect(screen.queryByRole("group", { name: "Template kind" })).toBeNull();
  expect(screen.queryByText(/question box/)).toBeNull();
  await userEvent.selectOptions(
    screen.getByLabelText("Default template"),
    "custom-retro",
  );
  expect(input.onDefaultTemplate).toHaveBeenCalledWith("custom-retro");
});

it("adds, edits and deletes a summary template", async () => {
  vi.mocked(api.saveSummaryTemplate).mockResolvedValue(settings);
  vi.mocked(api.deleteSummaryTemplate).mockResolvedValue(settings);
  const input = props();
  render(<SummaryTemplates {...input} />);
  await userEvent.click(screen.getByRole("button", { name: "New template" }));
  const add = screen.getByRole("button", { name: "Add template" });
  expect(add).toHaveProperty("disabled", true);
  await userEvent.type(screen.getByLabelText("Template name"), "Board");
  await userEvent.type(screen.getByLabelText("Template structure"), "## Risks");
  await userEvent.click(add);
  expect(api.saveSummaryTemplate).toHaveBeenCalledWith(
    null,
    "Board",
    "## Risks",
  );
  expect(input.onSettings).toHaveBeenCalledWith(settings);
  await userEvent.click(screen.getByRole("button", { name: "Edit Retro" }));
  expect(screen.getByDisplayValue("## Went well")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save template" }));
  expect(api.saveSummaryTemplate).toHaveBeenLastCalledWith(
    "custom-retro",
    "Retro",
    "## Went well",
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit Retro" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Delete template" }),
  );
  expect(api.deleteSummaryTemplate).toHaveBeenCalledWith("custom-retro");
});

it("saves the shared instructions when the field loses focus", async () => {
  vi.mocked(api.saveSummaryInstructions).mockResolvedValue(settings);
  const input = props();
  render(<SummaryTemplates {...input} />);
  const field = screen.getByLabelText("Saved summary instructions");
  await userEvent.type(field, "Be brief.");
  await userEvent.tab();
  expect(api.saveSummaryInstructions).toHaveBeenCalledWith("Be brief.");
  expect(input.onSettings).toHaveBeenCalledWith(settings);
});

it("keeps a failed save's draft and shows one sentence", async () => {
  vi.mocked(api.saveSummaryTemplate).mockRejectedValue({
    code: "summary_template",
    message: "Use at most 4000 characters without control characters.",
  });
  render(<SummaryTemplates {...props()} />);
  await userEvent.click(screen.getByRole("button", { name: "New template" }));
  await userEvent.type(screen.getByLabelText("Template name"), "Board");
  await userEvent.type(screen.getByLabelText("Template structure"), "## Risks");
  await userEvent.click(screen.getByRole("button", { name: "Add template" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Use at most 4000 characters without control characters.",
  );
  expect(screen.getByLabelText("Template name")).toHaveProperty(
    "value",
    "Board",
  );
  expect(screen.getByLabelText("Template structure")).toHaveProperty(
    "value",
    "## Risks",
  );
});

it("shows a plain list message when nothing is saved yet", () => {
  render(
    <SummaryTemplates
      {...props({
        ...settings,
        summary_templates: [],
        recipes: [],
      } as Settings)}
    />,
  );
  expect(screen.getByText("No saved templates")).toBeTruthy();
  expect(screen.getByText("0 saved")).toBeTruthy();
});
