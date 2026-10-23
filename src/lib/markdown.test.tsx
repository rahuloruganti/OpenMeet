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

  it("renders time tokens through a reference renderer, including inside bold", () => {
    const output = render(
      <div>
        {renderMarkdown("- **Ship [0:01]** then [9:99]\n`[0:01]`", (token) => (
          <mark>{token}</mark>
        ))}
      </div>,
    ).container.innerHTML;
    expect(output).toBe(
      "<div><ul><li><strong>Ship <mark>[0:01]</mark></strong> then <mark>[9:99]</mark></li></ul>" +
        "<p><code>[0:01]</code></p></div>",
    );
    expect(html("At [0:01].")).toBe("<div><p>At [0:01].</p></div>");
  });

  it("tokenizes meeting references only for a reference renderer", () => {
    const text = "Both agree [M1 0:08] and [M12], not [M1 9:99x] or [m1].";
    const output = render(
      <div>
        {renderMarkdown(text, (token) => (
          <mark>{token}</mark>
        ))}
      </div>,
    ).container.innerHTML;
    expect(output).toBe(
      "<div><p>Both agree <mark>[M1 0:08]</mark> and <mark>[M12]</mark>, not [M1 9:99x] or [m1].</p></div>",
    );
    expect(html(text)).toBe(`<div><p>${text}</p></div>`);
  });

  it("renders pipe tables with header, rule and body rows", () => {
    expect(
      html(
        "| Owner | Task |\n| --- | :--: |\n| Ana | **Send** `deck` |\n| Raj |\n\nAfter",
      ),
    ).toBe(
      '<div><div class="md-table"><table><thead><tr><th>Owner</th><th>Task</th></tr></thead>' +
        "<tbody><tr><td>Ana</td><td><strong>Send</strong> <code>deck</code></td></tr>" +
        "<tr><td>Raj</td><td></td></tr></tbody></table></div><p>After</p></div>",
    );
  });

  it("keeps escaped pipes in table cells and needs a rule row for a table", () => {
    expect(html("| a \\| b | c |\n| --- | --- |\n| 1 | 2 |")).toContain(
      "<th>a | b</th><th>c</th>",
    );
    expect(html("a | b\nplain line")).toBe(
      "<div><p>a | b plain line</p></div>",
    );
    // A rule with a different cell count is not a table.
    expect(html("a | b\n| --- |")).not.toContain("<table>");
  });

  it("nests bullet and numbered lists by indentation, with tabs", () => {
    expect(
      html("- one\n  - inner a\n  - inner b\n- two\n  1. first\n\t2. second"),
    ).toBe(
      "<div><ul><li>one<ul><li>inner a</li><li>inner b</li></ul></li>" +
        "<li>two<ol><li>first</li><li>second</li></ol></li></ul></div>",
    );
  });

  it("renders fenced code literally, without Markdown or HTML parsing", () => {
    expect(
      html(
        "Before\n```\nconst x = `a`;\n- not a list **x**\n<b>raw</b>\n```\nAfter",
      ),
    ).toBe(
      "<div><p>Before</p><pre><code>const x = `a`;\n- not a list **x**\n&lt;b&gt;raw&lt;/b&gt;</code></pre>" +
        "<p>After</p></div>",
    );
    // An unclosed fence runs to the end.
    expect(html("```\nopen")).toBe("<div><pre><code>open</code></pre></div>");
  });

  it("shows links as their label and URL text, never as anchors", () => {
    const output = html(
      "See [the plan](https://example.com/plan) and [docs](HTTP://x.test).",
    );
    expect(output).toBe(
      '<div><p>See the plan <span class="muted">(https://example.com/plan)</span> and docs ' +
        '<span class="muted">(HTTP://x.test)</span>.</p></div>',
    );
    expect(output).not.toMatch(/<a[\s>]/);
  });

  it.each([
    "[y](file:///C:/secret.txt)",
    "[z](data:text/html,hi)",
    "[x](javascript:void(0))",
  ])("keeps non-web link sources literal: %s", (input) => {
    expect(html(input)).toBe(`<div><p>${input}</p></div>`);
  });

  it("shows images as muted alt text and never loads them", () => {
    const output = html(
      "![Team photo](https://img.test/a.png) ![](https://img.test/b.png) ![x](javascript:bad())",
    );
    expect(output).toBe(
      '<div><p><span class="muted">[image: Team photo]</span> <span class="muted">[image]</span> ' +
        "![x](javascript:bad())</p></div>",
    );
    expect(output).not.toMatch(/<img[\s>]/);
  });

  it("renders task-list markers as read-only glyphs with text", () => {
    expect(html("- [ ] Draft\n- [x] Shipped")).toBe(
      '<div><ul><li><span role="img" aria-label="Not done">☐</span> Draft</li>' +
        '<li><span role="img" aria-label="Done">☑</span> Shipped</li></ul></div>',
    );
  });

  it("keeps timestamp tokens working inside tables and list items", () => {
    const output = render(
      <div>
        {renderMarkdown(
          "| At |\n| --- |\n| [0:01] |\n\n- [x] Ship [0:02]",
          (token) => (
            <mark>{token}</mark>
          ),
        )}
      </div>,
    ).container.innerHTML;
    expect(output).toBe(
      '<div><div class="md-table"><table><thead><tr><th>At</th></tr></thead><tbody>' +
        "<tr><td><mark>[0:01]</mark></td></tr></tbody></table></div>" +
        '<ul><li><span role="img" aria-label="Done">☑</span> Ship <mark>[0:02]</mark></li></ul></div>',
    );
  });

  it.each([
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["[x](javascript:alert(1))", "[x](javascript:alert(1))"],
    [
      "[y](file:///C:/x) and ![z](data:image/png;base64,AA)",
      "[y](file:///C:/x) and ![z](data:image/png;base64,AA)",
    ],
    ['<img src=x onerror="alert(1)">', '&lt;img src=x onerror="alert(1)"&gt;'],
    ["**<b>bold</b>**", "<strong>&lt;b&gt;bold&lt;/b&gt;</strong>"],
    ["`<i>`", "<code>&lt;i&gt;</code>"],
    ["**unclosed and `tick", "**unclosed and `tick"],
    ["#nospace", "#nospace"],
    [
      "| <script>x</script> | <b>y</b> |\n| --- | --- |\n| <img src=x> | ok |",
      "&lt;script&gt;x&lt;/script&gt;",
    ],
    ["```\n<script>x</script>\n```", "&lt;script&gt;x&lt;/script&gt;"],
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
