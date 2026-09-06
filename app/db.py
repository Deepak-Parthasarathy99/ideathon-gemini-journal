"""Durable journal storage. Every path is bound to the verified user's UID."""
import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from .config import settings

_client = None
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

class Conflict(Exception):
    pass


def valid_date(value):
    if not value or not DATE_RE.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def client():
    global _client
    if _client is None:
        _client = firestore.Client(project=settings.project_id or None)
    return _client


def _user_doc(uid):
    return client().collection("users").document(uid)


def _entries(uid):
    return _user_doc(uid).collection("entries")


def _clean(data):
    return {k: v for k, v in data.items() if v is not None}


def touch_user(uid, email, name):
    _user_doc(uid).set(_clean({"email": email, "name": name, "last_seen": datetime.now(timezone.utc)}), merge=True)


def _row(doc):
    data = doc.to_dict() or {}
    updated = data.get("updated_at")
    updated = updated.isoformat() if hasattr(updated, "isoformat") else None
    return {"date": doc.id, "text": data.get("text") if isinstance(data.get("text"), str) else "",
            "reflection": data.get("reflection") if isinstance(data.get("reflection"), str) else None,
            "updated_at": updated, "revision": data.get("revision") or updated or ""}


def get_entry(uid, date):
    doc = _entries(uid).document(date).get()
    return _row(doc) if doc.exists else None


def save_entry(uid, date, text, expected_text=None):
    ref = _entries(uid).document(date)
    @firestore.transactional
    def write(tx):
        snap = ref.get(transaction=tx)
        old = _row(snap) if snap.exists else {"text": "", "reflection": None, "revision": ""}
        # Retrying a confirmed-but-lost response is safe; never overwrite another draft.
        if expected_text is not None and old["text"] not in (expected_text, text):
            raise Conflict("This entry changed in another tab. Copy your draft, then reopen the day to compare it.")
        if old["text"] == text and snap.exists:
            return old
        now = datetime.now(timezone.utc)
        payload = {"text": text, "updated_at": now, "revision": uuid.uuid4().hex,
                   "reflection": firestore.DELETE_FIELD, "reflected_at": firestore.DELETE_FIELD}
        if not snap.exists:
            payload["created_at"] = now
        tx.set(ref, payload, merge=True)
        return {"date": date, "text": text, "reflection": None, "revision": payload["revision"], "updated_at": now.isoformat()}
    return write(client().transaction())


def set_reflection(uid, date, text, revision):
    ref = _entries(uid).document(date)
    @firestore.transactional
    def write(tx):
        snap = ref.get(transaction=tx)
        if not snap.exists or _row(snap)["revision"] != revision:
            raise Conflict("Your writing changed while Daybook was reading. Please ask it to read again.")
        tx.update(ref, {"reflection": text, "reflected_at": datetime.now(timezone.utc)})
    write(client().transaction())


def list_entries(uid, limit=30, before=None):
    # Document-ID ordering works for existing data, with no migration or composite index.
    query = _entries(uid).order_by("__name__", direction=firestore.Query.DESCENDING)
    if before:
        query = query.where(filter=FieldFilter("__name__", "<", _entries(uid).document(before)))
    rows = []
    # Skip legacy blank entries while keeping each Firestore request bounded.
    while len(rows) < limit:
        batch = list(query.limit(max(30, limit)).stream())
        if not batch:
            break
        rows.extend(row for doc in batch if (row := _row(doc))["text"].strip())
        if len(batch) < max(30, limit):
            break
        query = query.start_after(batch[-1])
    return list(reversed(rows[:limit]))


def written_days(uid, prefix):
    ref = _entries(uid)
    query = ref.where(filter=FieldFilter("__name__", ">=", ref.document(prefix + "-01")))
    query = query.where(filter=FieldFilter("__name__", "<=", ref.document(prefix + "-31")))
    return sorted(d.id for d in query.stream() if _row(d)["text"].strip())


def delete_entry(uid, date):
    ref = _entries(uid).document(date)
    for collection in ("thread", "requests"):
        for msg in ref.collection(collection).stream():
            msg.reference.delete()
    ref.delete()


def clear_journal(uid):
    days = list(_entries(uid).stream())
    for day in days:
        delete_entry(uid, day.id)
    for name in ("insights", "openers"):
        for cached in _user_doc(uid).collection(name).stream():
            cached.reference.delete()
    return len(days)


def thread(uid, date, limit=40):
    docs = list(_entries(uid).document(date).collection("thread").order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit).stream())
    return [{"role": d.to_dict().get("role"), "text": d.to_dict().get("text", "")} for d in reversed(docs)]


def begin_turn(uid, date, request_id, message):
    """Deduplicate retry input and serialize conversation turns across instances."""
    ref = _entries(uid).document(date)
    request = ref.collection("requests").document(request_id)
    @firestore.transactional
    def begin(tx):
        entry = ref.get(transaction=tx)
        previous = request.get(transaction=tx)
        data = previous.to_dict() or {}
        if not entry.exists:
            raise Conflict("This entry no longer exists.")
        if data and data.get("message") != message:
            raise Conflict("Retry the original message or send a new message.")
        if data.get("reply"):
            return data["reply"]
        if (entry.to_dict() or {}).get("pending_until", 0) > time.time():
            raise Conflict("Daybook is still answering. Wait a moment before retrying.")
        tx.update(ref, {"pending_request": request_id, "pending_until": time.time() + 90})
        tx.set(request, {"message": message}, merge=True)
        if not previous.exists:
            tx.set(ref.collection("thread").document(request_id + "-user"),
                   {"role": "user", "text": message, "created_at": datetime.now(timezone.utc)})
        return None
    return begin(client().transaction())


def finish_turn(uid, date, request_id, reply=None):
    ref = _entries(uid).document(date)
    @firestore.transactional
    def finish(tx):
        entry = ref.get(transaction=tx)
        if not entry.exists or entry.to_dict().get("pending_request") != request_id:
            raise Conflict("The conversation changed. Reopen the entry before continuing.")
        if reply is not None:
            tx.set(ref.collection("requests").document(request_id), {"reply": reply}, merge=True)
            tx.set(ref.collection("thread").document(request_id + "-assistant"),
                   {"role": "assistant", "text": reply, "created_at": datetime.now(timezone.utc)})
        tx.update(ref, {"pending_request": firestore.DELETE_FIELD, "pending_until": firestore.DELETE_FIELD})
    finish(client().transaction())


def allow_model(uid, per_minute):
    ref = _user_doc(uid).collection("limits").document("model")
    @firestore.transactional
    def claim(tx):
        snap = ref.get(transaction=tx)
        now = time.time()
        hits = [t for t in (snap.to_dict() or {}).get("hits", []) if t > now - 60]
        if len(hits) >= per_minute:
            return False
        tx.set(ref, {"hits": hits + [now]})
        return True
    return claim(client().transaction())


def fingerprint(entries):
    return hashlib.sha256(json.dumps([(e["date"], e["text"]) for e in entries], ensure_ascii=False).encode()).hexdigest()


def cached_insights(uid, day):
    return _user_doc(uid).collection("insights").document(day).get().to_dict()


def save_insights(uid, day, report):
    _user_doc(uid).collection("insights").document(day).set(_clean({**report, "created_at": datetime.now(timezone.utc)}))


def cached_opener(uid):
    return _user_doc(uid).collection("openers").document("current").get().to_dict()


def save_opener(uid, report):
    _user_doc(uid).collection("openers").document("current").set(_clean(report))
