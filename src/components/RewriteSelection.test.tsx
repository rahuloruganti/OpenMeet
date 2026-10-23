import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState, type ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { RewriteSelection } from "./RewriteSelection";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  api: { rewriteText: vi.fn() },
}));

function Harness(props: {
  initial: string;
  onApply?: (text: string) => void;
  blocked?: ComponentProps<typeof RewriteSelection>["blocked"];
  onOpenSettings?: ComponentProps<typeof RewriteSelection>["onOpenSettings"];
}) {
  const [notes, setNotes] = useState(props.initial);
  const editor = createRef<HTMLTextAreaElement>();
  return (
    <>
      <textarea
        aria-label="Notes"
        ref={editor}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      <RewriteSelection
        editor={editor}
        notes={notes}
        disabled={false}
        blocked={props.blocked ?? null}
        onOpenSettings={props.onOpenSettings ?? vi.fn()}
        onApply={(text) => {
          props.onApply?.(text);
          setNotes(text);
        }}
      />
    </>
  );
}

const notes = () => screen.getByLabelText("Notes") as HTMLTextAreaElement;
const select = (start: number, end: number) =>
  notes().setSelectionRange(start, end);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.rewriteText).mockResolvedValue("Short.");
});

it("shows why rewriting is unavailable and links to the Settings section that fixes it", async () => {
  const onOpenSettings = vi.fn();
  render(
    <Harness
      initial="Keep this."
      blocked={{
        message: "Choose a model for AI notes in Settings → AI notes.",
        section: "ai",
      }}
      onOpenSettings={onOpenSettings}
    />,
  );
  const rewrite = screen.getByRole("button", {
    name: "Rewrite selection…",
  }) as HTMLButtonElement;
  expect(rewrite.disabled).toBe(true);
  expect(rewrite.title).toBe(
    "Choose a model for AI notes in Settings → AI notes.",
  );
  expect(
    screen.getByText("Choose a model for AI notes in Settings → AI notes."),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Open Settings for AI notes" }),
  );
  expect(onOpenSettings).toHaveBeenCalledWith(
    "ai",
    expect.any(HTMLButtonElement),
  );
});

it("shows another running task as text without a Settings link", () => {
  render(
    <Harness
      initial="Keep this."
      blocked={{ message: "Another task is running.", section: null }}
    />,
  );
  expect(screen.getByText("Another task is running.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Open Settings/ })).toBeNull();
});

it("asks for a selection first and sends nothing without one", async () => {
  render(<Harness initial="Keep this." />);
  await userEvent.click(
    screen.getByRole("button", { name: "Rewrite selection…" }),
  );
  expect(screen.getByRole("status").textContent).toContain("Select text");
  expect(api.rewriteText).not.toHaveBeenCalled();
});

it("sends only the selection and replaces it only when accepted", async () => {
  const onApply = vi.fn();
  render(
    <Harness
      initial="Intro. A long rambling middle. Outro."
      onApply={onApply}
    />,
  );
  select(7, 30);
  await userEvent.click(
    screen.getByRole("button", { name: "Rewrite selection…" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Make it shorter" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Rewrite" }));
  expect(api.rewriteText).toHaveBeenCalledWith(
    "A long rambling middle.",
    "Make it shorter",
  );
  expect((await screen.findByLabelText("Rewritten text")).textContent).toBe(
    "Short.",
  );
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Replace selection" }),
  );
  expect(notes().value).toBe("Intro. Short. Outro.");
});

it("refuses to replace when the notes changed around the selection", async () => {
  const onApply = vi.fn();
  render(<Harness initial="Alpha beta gamma" onApply={onApply} />);
  select(6, 10);
  await userEvent.click(
    screen.getByRole("button", { name: "Rewrite selection…" }),
  );
  await userEvent.type(
    screen.getByLabelText("How should it change?"),
    "Capitalize",
  );
  await userEvent.click(screen.getByRole("button", { name: "Rewrite" }));
  await screen.findByLabelText("Rewritten text");
  await userEvent.type(notes(), "{Home}X");
  await userEvent.click(
    screen.getByRole("button", { name: "Replace selection" }),
  );
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain(
    "nothing was replaced",
  );
  expect(notes().value).toBe("XAlpha beta gamma");
});

it("shows a failed rewrite as an alert and leaves the notes unchanged", async () => {
  vi.mocked(api.rewriteText).mockRejectedValue({
    code: "provider_unreachable",
    message: "Cannot reach the selected provider.",
  });
  render(<Harness initial="Alpha beta" />);
  select(0, 5);
  await userEvent.click(
    screen.getByRole("button", { name: "Rewrite selection…" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Make it clearer" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Rewrite" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Cannot reach",
  );
  expect(screen.queryByLabelText("Rewritten text")).toBeNull();
  expect(notes().value).toBe("Alpha beta");
});
