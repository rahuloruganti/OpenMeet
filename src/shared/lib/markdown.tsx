import { Fragment, type ReactNode } from "react";
import { IconCheck } from "../ui/icons";

// Renders the Markdown the summary prompts and library answers emit: headings,
// nested `-`/`*`/`1.` lists, pipe tables, fenced and inline code, **bold**,
// links and images, and task-list markers. It builds React elements, never HTML
// strings, so anything else (tags, raw HTML) stays literal text. Links and
// images are never rendered as `<a>`/`<img>`: a link shows its URL as text and
// an image shows its alt text, so nothing navigates away or fetches a URL.
//
// Groups: 1 code, 2 bold, 3-4 image alt and URL, 5-6 link label and URL,
// 7 a `[m:ss]`, `[M2]` or `[s123]` reference token (rendered only with a renderer).
const inlinePattern =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|!\[([^\]\n]*)\]\(([^()\s]+)\)|\[([^\]\n]+)\]\(([^()\s]+)\)|(\[(?:M\d{1,2} )?(?:\d{1,2}:)?\d{1,3}:\d{2}\]|\[M\d{1,2}\]|\[s\d{1,12}\])/g;

/** Renders a `[m:ss]`, `[M2 m:ss]` or `[M2]` token, e.g. as a validated link; absent, tokens stay text. */
export type ReferenceRenderer = (token: string) => ReactNode;

type ListEntry = { indent: number; ordered: boolean; text: string };

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

function inline(text: string, reference?: ReferenceRenderer): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const [source, code, bold, imageAlt, imageUrl, linkLabel, linkUrl, token] =
      match;
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));
    last = at + source.length;
    const key = nodes.length;
    if (code !== undefined) {
      nodes.push(<code key={key}>{code}</code>);
    } else if (bold !== undefined) {
      nodes.push(<strong key={key}>{inline(bold, reference)}</strong>);
    } else if (imageUrl !== undefined) {
      nodes.push(
        isWebUrl(imageUrl) ? (
          <span key={key} className="muted">
            {imageAlt ? `[image: ${imageAlt}]` : "[image]"}
          </span>
        ) : (
          source
        ),
      );
    } else if (linkUrl !== undefined) {
      nodes.push(
        isWebUrl(linkUrl) ? (
          <Fragment key={key}>
            {inline(linkLabel ?? "", reference)}{" "}
            <span className="muted">({linkUrl})</span>
          </Fragment>
        ) : (
          source
        ),
      );
    } else if (token !== undefined) {
      nodes.push(<Fragment key={key}>{reference?.(token) ?? token}</Fragment>);
    }
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Task-list items get a read-only drawn checkbox with the same meaning in text. */
function itemContent(text: string, reference?: ReferenceRenderer): ReactNode {
  const task = /^\[([ xX])\](?:\s+(.*))?$/.exec(text);
  if (!task) return inline(text, reference);
  const done = task[1] !== " ";
  return (
    <>
      <span
        className={done ? "md-task is-done" : "md-task"}
        role="img"
        aria-label={done ? "Done" : "Not done"}
      >
        {done && <IconCheck size={12} strokeWidth={1.5} />}
      </span>{" "}
      {inline(task[2] ?? "", reference)}
    </>
  );
}

/** Items indented past the item before them become that item's sub-list. */
function renderList(
  entries: ListEntry[],
  from: number,
  to: number,
  reference?: ReferenceRenderer,
): ReactNode[] {
  const lists: ReactNode[] = [];
  let index = from;
  while (index < to) {
    const ordered = entries[index].ordered;
    const items: ReactNode[] = [];
    while (index < to && entries[index].ordered === ordered) {
      const entry = entries[index];
      let end = index + 1;
      while (end < to && entries[end].indent > entry.indent) end++;
      const children =
        end > index + 1 ? renderList(entries, index + 1, end, reference) : null;
      items.push(
        <li key={index}>
          {itemContent(entry.text, reference)}
          {children}
        </li>,
      );
      index = end;
    }
    lists.push(
      ordered ? (
        <ol key={lists.length}>{items}</ol>
      ) : (
        <ul key={lists.length}>{items}</ul>
      ),
    );
  }
  return lists;
}

/** Splits one pipe-table row into trimmed cells; `\|` is a literal pipe. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** A GFM table at `start`: a header row, a `---` rule with the same cell count, then body rows. */
function readTable(lines: string[], start: number) {
  const rule = lines[start + 1];
  if (rule === undefined || !lines[start].includes("|")) return null;
  const head = splitRow(lines[start]);
  const rules = splitRow(rule);
  if (
    rules.length !== head.length ||
    !rules.every((cell) => /^:?-+:?$/.test(cell))
  )
    return null;
  const rows: string[][] = [];
  let end = start + 2;
  while (
    end < lines.length &&
    lines[end].trim() !== "" &&
    lines[end].includes("|")
  )
    rows.push(splitRow(lines[end++]));
  return { head, rows, end };
}

export function renderMarkdown(
  markdown: string,
  reference?: ReferenceRenderer,
): ReactNode[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let entries: ListEntry[] = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push(
        <p key={blocks.length}>{inline(paragraph.join(" "), reference)}</p>,
      );
    if (entries.length > 0)
      blocks.push(
        <Fragment key={blocks.length}>
          {renderList(entries, 0, entries.length, reference)}
        </Fragment>,
      );
    paragraph = [];
    entries = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    const bullet = /^(\s*)[-*]\s+(.+)$/.exec(line);
    const item = bullet ?? /^(\s*)\d+\.\s+(.+)$/.exec(line);
    const table = heading || quote ? null : readTable(lines, index);
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      // An unclosed fence runs to the end of the text, as in CommonMark.
      while (index + 1 < lines.length && !/^\s*```\s*$/.test(lines[index + 1]))
        body.push(lines[++index]);
      if (index + 1 < lines.length) index++;
      blocks.push(
        <pre key={blocks.length}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
    } else if (heading) {
      flush();
      blocks.push(
        <h4 key={blocks.length}>{inline(heading[1].trim(), reference)}</h4>,
      );
    } else if (quote) {
      flush();
      // Consecutive quoted lines are one quote; a blank line ends it.
      const body = [quote[1]];
      while (index + 1 < lines.length) {
        const next = /^\s*>\s?(.*)$/.exec(lines[index + 1]);
        if (!next) break;
        body.push(next[1]);
        index++;
      }
      blocks.push(
        <blockquote key={blocks.length}>
          <p>{inline(body.join(" "), reference)}</p>
        </blockquote>,
      );
    } else if (table) {
      flush();
      blocks.push(
        <div className="md-table" key={blocks.length}>
          <table>
            <thead>
              <tr>
                {table.head.map((cell, column) => (
                  <th key={column}>{inline(cell, reference)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {table.head.map((_, column) => (
                    <td key={column}>{inline(row[column] ?? "", reference)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      // The loop's own increment moves past the table's last line.
      index = table.end - 1;
    } else if (item) {
      if (paragraph.length > 0) flush();
      entries.push({
        // A tab counts as two spaces of indentation.
        indent: item[1].replace(/\t/g, "  ").length,
        ordered: !bullet,
        text: item[2].trim(),
      });
    } else if (line.trim() === "") {
      flush();
    } else {
      if (entries.length > 0) flush();
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
