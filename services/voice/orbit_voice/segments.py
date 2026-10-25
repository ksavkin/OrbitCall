"""Stable phrase ids (lesson R10): `<roomId>:<identity>:<epoch>:<n>` and a monotonic rev per segment.

The epoch is the session start plus a random nonce, so a reconnected STT session (or a restarted worker) never
reuses an id; Convex keeps the row with the higher rev of one segId.
"""

from __future__ import annotations

import secrets
import time


class SegmentIds:
    def __init__(self, room_id: str, identity: str, clock=time.time) -> None:
        self._prefix = f"{room_id}:{identity}"
        self._clock = clock
        self.new_epoch()

    def new_epoch(self) -> str:
        """A new STT session (first connect, reconnect after a drop): a fresh id space."""
        self.epoch = f"{int(self._clock() * 1000):x}-{secrets.token_hex(3)}"
        self._n = 0
        return self.epoch

    def next_segment(self) -> "Segment":
        self._n += 1
        return Segment(f"{self._prefix}:{self.epoch}:{self._n}")


class Segment:
    def __init__(self, seg_id: str) -> None:
        self.seg_id = seg_id
        self._rev = 0

    def next_rev(self) -> int:
        """Invariant: revisions are allocated in handler order (pending, final, then a later failure), synchronously
        when each row is built, before its post is sent. The posts themselves run in the background and may arrive
        in any order; Convex keeps the highest rev, which is therefore always the latest state of the phrase."""
        self._rev += 1
        return self._rev
