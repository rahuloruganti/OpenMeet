"""Enhanced notes: the user's notes plus the final transcript, every claim cited to transcript segments.

Each transcript line starts with its segment id as a marker, [s123]. The model cites markers inline.
After the reply every marker is checked against this meeting's real segment ids: invalid ones are
removed and counted, valid ones become the row's sources. The raw notes are read here, never written.
Used by manual Enhance notes (summaries.enhance_notes) and by the automatic processing summary step.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

from openmeet_py.api import reads
from openmeet_py.api.context import byte_len
from openmeet_py.api.errors import AppError
from openmeet_py.domain import llm, providers

# Same budget as a summary request: system prompt and notes and transcript together, in UTF-8 bytes.
MAX_ENHANCE_INPUT = llm.MAX_SUMMARY_INPUT
TAG_BYTES = 64  # the <notes> and <transcript> wrappers
GAP_RESERVE = 160  # room for the line that says how many transcript lines were left out
NESTED = re.compile(r"\[\[s(\d+)\]\]")
MARKER = re.compile(r"([ \t]*)\[s(\d+)\]")

ENHANCE_PROMPT = (
    "You enhance the user's rough meeting notes with the meeting transcript. The notes are the user's "
    "own words: keep their wording where it is present, then expand and organize them with what the "
    "transcript supports. Each transcript line starts with a marker such as [s12]. Cite the marker of "
    "every transcript line behind a claim, copied exactly; several are allowed, for example [s12][s14]. "
    "Use only markers that appear in the transcript and never invent one. Mark anything the notes and "
    "transcript do not support as Unknown instead of guessing. Never invent participant names; use only "
    "the speaker names shown in the transcript. Output Markdown only."
)

# A transcript line as it is numbered for the request: segment id, start and end in ms, "Speaker: text".
Item = tuple[int, Optional[int], Optional[int], str]


@dataclass(frozen=True)
class Plan:
    system: str
    user: str
    total: int  # transcript lines in the meeting
    trimmed: int  # lines left out of the request to fit the limit
    # Only the lines the request kept: a marker for a trimmed line was never seen by the model, so it is dropped.
    targets: dict[int, tuple[Optional[int], Optional[int]]]


def system_prompt(task: str, instructions: str) -> str:
    personal = (
        f" Also follow these saved personal instructions where they do not conflict with the rules below:\n"
        f"<instructions>\n{instructions}\n</instructions>\n"
        if instructions
        else ""
    )
    return f"{ENHANCE_PROMPT} {task}{personal} {llm.RULES}"


def span(timing: dict[str, Any]) -> tuple[Optional[int], Optional[int]]:
    if timing["kind"] == "timed":
        return timing["start_ms"], timing["end_ms"]
    return None, None


def items_of(detail: dict[str, Any]) -> list[Item]:
    """Numbered transcript items of a meeting detail, in the order the transcript shows them."""
    names = detail["speaker_names"]
    return [
        (meta["id"], *span(segment["timing"]), f"{reads.label(names, segment['speaker'])}: {segment['text']}")
        for meta, segment in zip(detail["segment_meta"], detail["segments"])
    ]


def targets_of(db: sqlite3.Connection, meeting_id: str) -> dict[int, tuple[Optional[int], Optional[int]]]:
    segments, meta = reads.segments_of(db, meeting_id)
    return {row["id"]: span(segment["timing"]) for segment, row in zip(segments, meta)}


def _keep_ends(costs: list[int], budget: int) -> tuple[list[int], list[int]]:
    """Indexes taken alternately from the start and the end while the byte budget lasts."""
    head: list[int] = []
    tail: list[int] = []
    low, high = 0, len(costs)
    from_start = True
    while low < high:
        index = low if from_start else high - 1
        cost = costs[index]
        if cost > budget:
            break
        budget -= cost
        if from_start:
            head.append(index)
            low += 1
        else:
            tail.append(index)
            high -= 1
        from_start = not from_start
    return head, list(reversed(tail))


def plan(notes: str, items: Sequence[Item], system: str) -> Plan:
    """The one request for this meeting. Notes are kept whole; transcript lines are dropped from the middle.

    Citation targets are the kept lines only: a line the model was never sent cannot be cited.
    """
    lines = [f"[s{item[0]}] {item[3]}" for item in items]
    fixed = byte_len(system) + byte_len(notes) + TAG_BYTES
    if fixed > MAX_ENHANCE_INPUT:
        raise AppError(
            "summary_too_long",
            "Your notes are too long to enhance in one request. Nothing was sent.",
        )
    room = MAX_ENHANCE_INPUT - fixed
    costs = [byte_len(line) + 1 for line in lines]
    if sum(costs) <= room:
        kept = list(range(len(items)))
        transcript_lines = lines
        trimmed = 0
    else:
        head, tail = _keep_ends(costs, room - GAP_RESERVE)
        if not head and not tail:
            raise AppError(
                "summary_too_long",
                "The transcript is too long to enhance in one request. Nothing was sent.",
            )
        kept = head + tail
        trimmed = len(items) - len(kept)
        gap = [f"… {trimmed} transcript lines left out to fit the size limit …"]
        transcript_lines = [lines[index] for index in head] + gap + [lines[index] for index in tail]
    targets = {items[index][0]: (items[index][1], items[index][2]) for index in kept}
    transcript = "\n".join(transcript_lines)
    user = f"<notes>\n{notes}\n</notes>\n\n<transcript>\n{transcript}\n</transcript>"
    return Plan(system=system, user=user, total=len(lines), trimmed=trimmed, targets=targets)


def request(connection: providers.Connection, planned: Plan, before: llm.BeforeRequest) -> str:
    """One chat request. Nothing is retried; an empty reply is refused, not saved."""
    markdown = llm.chat(connection, planned.system, planned.user, before)
    if not markdown.strip():
        raise AppError("provider_response", "The model returned no enhanced notes. Nothing was saved.")
    return markdown


def link_sources(
    markdown: str, targets: Mapping[int, tuple[Optional[int], Optional[int]]]
) -> tuple[str, list[dict[str, Any]], int]:
    """Keeps markers that name a real segment, removes the others. Returns (text, sources, dropped).

    A zero-padded id such as [s01] names no segment: it is invalid and removed, not rewritten to [s1].
    """
    text = NESTED.sub(r"[s\1]", markdown)
    sources: list[dict[str, Any]] = []
    seen: set[int] = set()
    dropped = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal dropped
        spaces, digits = match.group(1), match.group(2)
        segment_id = int(digits)
        if digits != str(segment_id) or segment_id not in targets:
            dropped += 1
            return ""
        if segment_id not in seen:
            seen.add(segment_id)
            start_ms, end_ms = targets[segment_id]
            sources.append(
                {"marker": f"[s{segment_id}]", "segment_id": segment_id, "start_ms": start_ms, "end_ms": end_ms}
            )
        return f"{spaces}[s{segment_id}]"

    return MARKER.sub(replace, text), sources, dropped


def store(
    db: sqlite3.Connection,
    meeting_id: str,
    template: str,
    config: dict[str, Any],
    markdown: str,
    sources: list[dict[str, Any]],
    notes_revision: int,
    transcript_hash: str,
) -> int:
    if not markdown.strip():
        raise AppError("provider_response", "The model returned no enhanced notes. Nothing was saved.")
    cursor = db.execute(
        "INSERT INTO summaries(meeting_id, template_hash, model, provider, markdown, transcript_hash, "
        "kind, notes_revision, sources_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'enhanced', ?7, ?8)",
        (
            meeting_id,
            template,
            config["model"],
            config["base_url"],
            markdown,
            transcript_hash,
            notes_revision,
            json.dumps(sources, ensure_ascii=False),
        ),
    )
    new_id = cursor.lastrowid
    assert new_id is not None  # an INSERT always yields a rowid
    return new_id

