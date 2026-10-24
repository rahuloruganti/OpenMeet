"""Live transcript: bounded per-lane audio queues, one worker, and three kinds of decoder.

Public surface (A2 wires this into the recorder and the commands):

    Update, LaneDecoder, Resolved, resolve, listing, LiveSession
"""

from openmeet_py.speech.live.contract import TARGET_RATE, LaneDecoder, Resolved, Update, speaker
from openmeet_py.speech.live.decoders import (
    CloudDecoder,
    FakeDecoder,
    LevelGate,
    SileroGate,
    StreamingDecoder,
    VadDecoder,
)
from openmeet_py.speech.live.select import listing, resolve
from openmeet_py.speech.live.session import LiveSession

__all__ = [
    "TARGET_RATE",
    "CloudDecoder",
    "FakeDecoder",
    "LaneDecoder",
    "LevelGate",
    "LiveSession",
    "Resolved",
    "SileroGate",
    "StreamingDecoder",
    "Update",
    "VadDecoder",
    "listing",
    "resolve",
    "speaker",
]
