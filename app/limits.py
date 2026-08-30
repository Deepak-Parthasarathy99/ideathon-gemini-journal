"""A per-user request cap, so one visitor can't run the model bill up.

Honest caveat: this counts inside a single container. Cloud Run may run
several at once, so the real ceiling is the limit multiplied by the number
of live instances. That is enough to stop casual abuse during judging;
a production system would keep the counter in Firestore or Redis.
"""

import time
from collections import defaultdict, deque

_hits: dict[str, deque] = defaultdict(deque)
_WINDOW_SECONDS = 60


def allow(uid: str, per_minute: int) -> bool:
    now = time.monotonic()
    window = _hits[uid]

    while window and now - window[0] > _WINDOW_SECONDS:
        window.popleft()

    if len(window) >= per_minute:
        return False

    window.append(now)
    return True
