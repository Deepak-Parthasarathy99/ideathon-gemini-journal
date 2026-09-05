"""Firestore access, always scoped to one user.

The unit of storage is an ENTRY: one piece of writing belonging to one day,
at users/{uid}/entries/{YYYY-MM-DD}. Daybook's reflection is a field on that
entry, not a separate message — which is the whole difference between a
journal and a chat log.

A "talk this through" exchange hangs off an entry as a subcollection, so a
conversation is a branch of a day's writing rather than the shape of the
whole app.

Cloud Run throws the container away between requests, so anything worth
keeping lands here immediately. Every read and write below is keyed by uid,
which is where the per-user isolation actually comes from.
"""

import re
from datetime import datetime, timezone

from google.cloud import firestore

from .config import settings

_client: firestore.Client | None = None

# The browser tells us which day it is where the person actually is —
# a server in UTC would file an evening entry in Chennai under tomorrow.
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def valid_date(value: str) -> bool:
    if not value or not DATE_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def client() -> firestore.Client:
    global _client
    if _client is None:
        _client = firestore.Client(project=settings.project_id or None)
    return _client


def _user_doc(uid: str):
    return client().collection("users").document(uid)


def _entries(uid: str):
    return _user_doc(uid).collection("entries")


def _clean(data: dict) -> dict:
    """Drop None values before persisting — the challenge checklist forbids
    writing undefined fields, and Firestore queries behave better without
    them anyway."""
    return {k: v for k, v in data.items() if v is not None}


def touch_user(uid: str, email: str | None, name: str | None) -> None:
    """Record that this person exists. Safe to call on every sign-in."""
    _user_doc(uid).set(
        _clean(
            {
                "email": email,
                "name": name,
                "last_seen": datetime.now(timezone.utc),
            }
        ),
        merge=True,
    )


# --- Entries ---------------------------------------------------------------


def _row(doc) -> dict:
    data = doc.to_dict() or {}
    updated = data.get("updated_at")
    return {
        "date": doc.id,
        "text": data.get("text", ""),
        "reflection": data.get("reflection"),
        "updated_at": updated.isoformat() if updated else None,
    }


def get_entry(uid: str, date: str) -> dict | None:
    doc = _entries(uid).document(date).get()
    return _row(doc) if doc.exists else None


def save_entry(uid: str, date: str, text: str) -> dict:
    """Create or replace the writing for one day.

    Editing the text clears any reflection: Daybook answered what was there
    before, and leaving a stale response attached to changed writing would
    be worse than showing none.
    """
    existing = get_entry(uid, date)
    changed = existing is None or existing["text"] != text

    payload = {
        "text": text,
        "updated_at": datetime.now(timezone.utc),
    }
    if existing is None:
        payload["created_at"] = datetime.now(timezone.utc)
    if changed:
        payload["reflection"] = firestore.DELETE_FIELD

    _entries(uid).document(date).set(_clean(payload), merge=True)
    return {"date": date, "text": text, "reflection": None if changed else (existing or {}).get("reflection")}


def set_reflection(uid: str, date: str, text: str) -> None:
    _entries(uid).document(date).set(
        _clean({"reflection": text, "reflected_at": datetime.now(timezone.utc)}),
        merge=True,
    )


def list_entries(uid: str, limit: int = 30, before: str | None = None) -> list[dict]:
    """Recent entries, oldest first, which is what everything downstream wants.

    `before` keeps a day's context honest: filling in last Tuesday should
    read only what existed by last Tuesday. Without it a reflection on an
    older entry would quote days that had not happened yet.

    Read and sorted here rather than ordered by Firestore. Document ids are
    dates, so sorting them as strings is chronological, and doing it in
    Python needs no index and cannot disagree with the calendar. A journal
    is tens or hundreds of documents; if one ever ran to thousands this
    would want a real ordered query on a stored date field.
    """
    rows = [_row(d) for d in _entries(uid).stream() if (d.to_dict() or {}).get("text")]
    if before:
        rows = [r for r in rows if r["date"] < before]
    rows.sort(key=lambda r: r["date"])
    return rows[-limit:]


def written_days(uid: str, prefix: str) -> list[str]:
    """Which days in a month have writing. `prefix` is 'YYYY-MM'.

    Filtered in Python for the same reason as list_entries: no index, and
    no cursor syntax to get wrong.
    """
    return sorted(
        d.id
        for d in _entries(uid).stream()
        if d.id.startswith(prefix) and (d.to_dict() or {}).get("text")
    )


def delete_entry(uid: str, date: str) -> None:
    for msg in _entries(uid).document(date).collection("thread").stream():
        msg.reference.delete()
    _entries(uid).document(date).delete()


def clear_journal(uid: str) -> int:
    """Delete everything this person has written. Returns how many days went."""
    days = list(_entries(uid).stream())
    for day in days:
        delete_entry(uid, day.id)
    for cached in _user_doc(uid).collection("insights").stream():
        cached.reference.delete()
    return len(days)


# --- The optional exchange hanging off one entry ---------------------------


def add_thread_message(uid: str, date: str, role: str, text: str) -> None:
    _entries(uid).document(date).collection("thread").add(
        _clean({"role": role, "text": text, "created_at": datetime.now(timezone.utc)})
    )


def thread(uid: str, date: str, limit: int = 40) -> list[dict]:
    docs = (
        _entries(uid)
        .document(date)
        .collection("thread")
        .order_by("created_at")
        .limit(limit)
        .stream()
    )
    return [
        {"role": (d.to_dict() or {}).get("role"), "text": (d.to_dict() or {}).get("text")}
        for d in docs
    ]


# --- Insights cache --------------------------------------------------------


def cached_insights(uid: str, day: str) -> dict | None:
    doc = _user_doc(uid).collection("insights").document(day).get()
    return doc.to_dict() if doc.exists else None


def save_insights(uid: str, day: str, report: dict) -> None:
    _user_doc(uid).collection("insights").document(day).set(
        _clean({**report, "created_at": datetime.now(timezone.utc)})
    )
