import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { SourceRef } from "../../shared/api/api";
import { renderMarkdown } from "../../shared/lib/markdown";
import { isSourceMarker, sourceChip } from "./sources";

const sources: SourceRef[] = [
  { marker: "[s12]", segment_id: 12, start_ms: 5000, end_ms: 9000 },
  { marker: "[s40]", segment_id: 40, start_ms: null, end_ms: null },
];

it("recognises only source markers, not timestamps", () => {
  expect(isSourceMarker("[s12]")).toBe(true);
  expect(isSourceMarker("[s1203]")).toBe(true);
  expect(isSourceMarker("[00:05]")).toBe(false);
  expect(isSourceMarker("[M2]")).toBe(false);
  expect(isSourceMarker("s12")).toBe(false);
});

it("renders each cited marker as a chip titled with its time range", () => {
  render(
    <div>
      {renderMarkdown(
        "Budget agreed [s12][s12] then [s40].",
        sourceChip(sources, vi.fn()),
      )}
    </div>,
  );
  const chips = screen.getAllByRole("button", {
    name: "Open transcript at 00:05 to 00:09",
  });
  expect(chips).toHaveLength(2);
  expect(chips[0].getAttribute("title")).toBe("00:05 to 00:09");
  expect(
    screen.getByRole("button", { name: "Open transcript, untimed segment" }),
  ).toBeTruthy();
});

it("sends the cited source, with its start in ms, when a chip is clicked", async () => {
  const onOpen = vi.fn();
  render(
    <div>
      {renderMarkdown("Ship on Friday [s12].", sourceChip(sources, onOpen))}
    </div>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open transcript at 00:05 to 00:09" }),
  );
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ segment_id: 12, start_ms: 5000 }),
  );
});

it("shows no text for a marker that names no cited source", () => {
  const { container } = render(
    <div>
      {renderMarkdown("Known [s12] and [s99].", sourceChip(sources, vi.fn()))}
    </div>,
  );
  expect(container.textContent).not.toContain("[s99]");
  expect(container.textContent).toContain("Known");
});

it("leaves timestamps to the transcript reference renderer", () => {
  const { container } = render(
    <div>
      {renderMarkdown("At [00:05] we agreed.", sourceChip(sources, vi.fn()))}
    </div>,
  );
  expect(container.textContent).toContain("[00:05]");
});
