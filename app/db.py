"""Firestore access, always scoped to one user.

Cloud Run throws the container away between requests, so anything worth
keeping lands here immediately. Every read and write below is keyed by uid,
which is where the per-user isolation actually comes from.
"""

from datetime import datetime, timezone

from google.cloud import firestore

from .config import settings

_client: firestore.Client | None = None


def client() -> firestore.Client:
    global _client
    if _client is None:
        _client = firestore.Client(project=settings.project_id or None)
    return _client


def _user_doc(uid: str):
    return client().collection("users").document(uid)


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


def add_message(uid: str, role: str, text: str) -> None:
    """Append one turn of the journal for this user."""
    _user_doc(uid).collection("messages").add(
        _clean(
            {
                "role": role,
                "text": text,
                "created_at": datetime.now(timezone.utc),
            }
        )
    )


def recent_messages(uid: str, limit: int = 50) -> list[dict]:
    """Most recent turns, oldest first — the order a chat window wants."""
    snapshot = (
        _user_doc(uid)
        .collection("messages")
        .order_by("created_at", direction=firestore.Query.DESCENDING)
        .limit(limit)
        .stream()
    )
    rows = []
    for doc in snapshot:
        data = doc.to_dict()
        created = data.get("created_at")
        rows.append(
            {
                "id": doc.id,
                "role": data.get("role"),
                "text": data.get("text"),
                "created_at": created.isoformat() if created else None,
            }
        )
    rows.reverse()
    return rows


def user_entries(uid: str, limit: int = 30) -> list[dict]:
    """The journal itself: the user's own words, oldest first.

    Every message the user sends IS a journal entry — there is no separate
    collection to fall out of sync with the transcript.
    """
    # Filtered in Python rather than with a where(): combining where and
    # order_by in Firestore demands a composite index, and a missing index
    # fails only in production. Reading twice the limit keeps it correct.
    recent = recent_messages(uid, limit=limit * 2)
    entries = [
        {"text": m["text"], "created_at": m["created_at"]}
        for m in recent
        if m["role"] == "user"
    ]
    return entries[-limit:]


def cached_insights(uid: str, day: str) -> dict | None:
    """Today's insight report, if it was already generated."""
    doc = _user_doc(uid).collection("insights").document(day).get()
    return doc.to_dict() if doc.exists else None


def save_insights(uid: str, day: str, report: dict) -> None:
    _user_doc(uid).collection("insights").document(day).set(
        _clean({**report, "created_at": datetime.now(timezone.utc)})
    )


def clear_messages(uid: str) -> int:
    """Delete this user's conversation. Returns how many turns went."""
    docs = list(_user_doc(uid).collection("messages").stream())
    for doc in docs:
        doc.reference.delete()
    return len(docs)
