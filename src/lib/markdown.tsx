import { Fragment, type ReactNode } from "react";

// Renders only the subset the summary prompts emit: headings, `-`/`*`/`1.`
// lists, **bold**, `code` and paragraphs. It builds React elements, never HTML
// strings, so anything else (tags, links, images) stays literal text.
const inlinePattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;
// The same subset plus time tokens, matching `timestampTokens`.
const referencePattern =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[(?:\d{1,2}:)?\d{1,3}:\d{2}\])/;

/** Renders a `[m:ss]` token, e.g. as a validated link; absent, tokens stay text. */
export type ReferenceRenderer = (token: string) => ReactNode;

function inline(text: string, reference?: ReferenceRenderer): ReactNode[] {
  return text
    .split(reference ? referencePattern : inlinePattern)
    .map((part, index) =>
      index % 2 === 0 ? (
        <Fragment key={index}>{part}</Fragment>
      ) : part.startsWith("**") ? (
        <strong key={index}>
          {reference ? inline(part.slice(2, -2), reference) : part.slice(2, -2)}
        </strong>
      ) : part.startsWith("`") ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        <Fragment key={index}>{reference?.(part) ?? part}</Fragment>
      ),
    );
}

export function renderMarkdown(
  markdown: string,
  reference?: ReferenceRenderer,
): ReactNode[] {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    const key = blocks.length;
    if (paragraph.length > 0)
      blocks.push(<p key={key}>{inline(paragraph.join(" "), reference)}</p>);
    if (list) {
      const items = list.items.map((item, index) => (
        <li key={index}>{inline(item, reference)}</li>
      ));
      blocks.push(
        list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
    }
    paragraph = [];
    list = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const item = bullet ?? /^\s*\d+\.\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(
        <h4 key={blocks.length}>{inline(heading[1].trim(), reference)}</h4>,
      );
    } else if (item) {
      const ordered = !bullet;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[1].trim());
    } else if (line.trim() === "") {
      flush();
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/**
 * The body of the `## heading` section (case-insensitive), up to the next
 * heading of the same or a higher level; null when the heading is missing.
 */
export function extractSection(
  markdown: string,
  heading: string,
): string | null {
  const wanted = heading.trim().toLowerCase();
  let level = 0;
  const body: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (level === 0) {
      if (match?.[2].toLowerCase() === wanted) level = match[1].length;
    } else if (match && match[1].length <= level) {
      break;
    } else {
      body.push(line);
    }
  }
  return level === 0 ? null : body.join("\n").trim();
}
