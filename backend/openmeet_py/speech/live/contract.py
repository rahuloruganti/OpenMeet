"""The live transcript contract shared by the decoders, the session and the resolver.

Samples are lane-local 16 kHz mono positions: one lane's own stream of samples from the first
accepted block, with no paused audio in it. Session milliseconds come later, from the capture
clock carried by each block.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

TARGET_RATE = 16_000
MIC = "mic"
SYSTEM = "system"
SPEAKERS = {MIC: "You", SYSTEM: "Others"}


@dataclass(frozen=True)
class Update:
    """One decoder result: a partial replaces the text of its utterance, a final closes it."""

    utterance: int
    text: str
    start: int
    end: int
    final: bool


class LaneDecoder(Protocol):
    """What a lane feeds. Implementations never raise for ordinary audio and never log text."""

    def feed(self, samples16k) -> list[Update]: ...

    def finish(self) -> list[Update]: ...


@dataclass(frozen=True)
class Resolved:
    """The chosen live engine: a label for the UI and a factory called once per lane."""

    label: str
    leaves_device: bool
    make_decoder: Callable[[], LaneDecoder]


def speaker(kind: str) -> str:
    return SPEAKERS.get(kind, "Others")
