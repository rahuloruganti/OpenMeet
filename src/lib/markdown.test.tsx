import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { extractSection, renderMarkdown } from "./markdown";

const html = (markdown: string) =>
  render(<div>{renderMarkdown(markdown)}</div>).container.innerHTML;

describe("renderMarkdown", () => {
  it("renders the prompt subset as elements", () => {
    expect(
      html(
        "## Summary\nA **firm** plan with `code`.\nSame paragraph.\n\n- one\n- two\n1. first\n2. second",
      ),
    ).toBe(
      "<div><h4>Summary</h4><p>A <strong>firm</strong> plan with <code>code</code>. Same paragraph.</p>" +
        "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol></div>",
    );
  });

  it.each([
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["[x](javascript:alert(1))", "[x](javascript:alert(1))"],
    ['<img src=x onerror="alert(1)">', '&lt;img src=x onerror="alert(1)"&gt;'],
    ["**<b>bold</b>**", "<strong>&lt;b&gt;bold&lt;/b&gt;</strong>"],
    ["`<i>`", "<code>&lt;i&gt;</code>"],
    ["**unclosed and `tick", "**unclosed and `tick"],
    ["#nospace", "#nospace"],
  ])("keeps hostile or unknown input literal: %s", (input, inner) => {
    const output = html(input);
    expect(output).not.toMatch(/<(script|img|a|b|i)[\s>]/);
    expect(output).toContain(inner);
  });
});

describe("extractSection", () => {
  const summary =
    "## Summary\nShort.\n\n## Action items\n- Ana: send deck\n- Raj: book room\n";

  it("returns the section body up to the next heading", () => {
    expect(extractSection(`${summary}## Notes\nlater`, "Action items")).toBe(
      "- Ana: send deck\n- Raj: book room",
    );
  });

  it("handles a last section, CRLF and case", () => {
    expect(extractSection(summary.replace(/\n/g, "\r\n"), "action ITEMS")).toBe(
      "- Ana: send deck\n- Raj: book room",
    );
  });

  it("keeps deeper subheadings and returns null when missing", () => {
    expect(
      extractSection("## Action items\n### Ana\n- x\n# Next", "Action items"),
    ).toBe("### Ana\n- x");
    expect(
      extractSection("## Summary\nNo actions.", "Action items"),
    ).toBeNull();
  });
});
