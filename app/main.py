"""The one entry point. Serves the interface and the API from a single container.

Request path:
    browser -> verify Firebase ID token -> Firestore / Gemini

Cloud Run itself is deployed public so anyone can load the page. The app is
what refuses to do anything until a valid token shows up.
"""

import logging
import uuid
from datetime import date as date_type

from fastapi import FastAPI, HTTPException, status
from starlette.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, journal
from .agent import ask
from .auth import CurrentUser, User
from .config import settings

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="Daybook Journal", docs_url=None, redoc_url=None)


@app.middleware("http")
async def private_responses(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


@app.on_event("startup")
def warn_about_missing_config() -> None:
    gaps = settings.missing()
    if gaps:
        log.warning("Not configured yet: %s", ", ".join(gaps))


# --- Health ----------------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict:
    """Cheap liveness check. Deliberately requires no auth and touches nothing."""
    return {"status": "ok"}


@app.get("/api/config")
def public_config() -> dict:
    """Firebase web config for the browser. Not a secret — it names the
    project, it does not grant access to it."""
    return settings.web_config()


# --- Shapes ----------------------------------------------------------------


class EntryBody(BaseModel):
    text: str = Field(max_length=20000)
    expected_text: str | None = Field(default=None, max_length=20000)


class ThreadBody(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    request_id: uuid.UUID = Field(default_factory=uuid.uuid4)


def _check_date(value: str) -> str:
    if not db.valid_date(value):
        raise HTTPException(status_code=400, detail="That isn't a date we understand.")
    return value


def _rate_limit(uid: str) -> None:
    if not db.allow_model(uid, settings.rate_limit_per_minute):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="You're going faster than we can answer. Wait a moment.",
        )


# --- Account ---------------------------------------------------------------


@app.get("/api/me")
def me(user: User = CurrentUser) -> dict:
    db.touch_user(user.uid, user.email, user.name)
    return user.as_dict()


# --- Entries ---------------------------------------------------------------


@app.get("/api/entries")
def recent_entries(before: str | None = None, user: User = CurrentUser) -> dict:
    if before:
        _check_date(before)
    entries = db.list_entries(user.uid, limit=31, before=before)
    more = len(entries) > 30
    entries = entries[-30:]
    return {"entries": entries, "next_before": entries[0]["date"] if more else None}


@app.get("/api/entries/{date}")
def one_entry(date: str, user: User = CurrentUser) -> dict:
    date = _check_date(date)
    entry = db.get_entry(user.uid, date) or {"date": date, "text": "", "reflection": None}
    return {"entry": entry, "thread": db.thread(user.uid, date)}


@app.put("/api/entries/{date}")
def write_entry(date: str, body: EntryBody, user: User = CurrentUser) -> dict:
    """Autosave. Cheap, frequent, and it never calls the model."""
    date = _check_date(date)
    return {"entry": db.save_entry(user.uid, date, body.text.strip(), body.expected_text)}


@app.delete("/api/entries")
def clear_journal(user: User = CurrentUser) -> dict:
    return {"deleted": db.clear_journal(user.uid)}


@app.get("/api/calendar/{month}")
def calendar(month: str, user: User = CurrentUser) -> dict:
    """Which days in a 'YYYY-MM' month have writing."""
    if not db.valid_date(f"{month}-01"):
        raise HTTPException(status_code=400, detail="That isn't a month we understand.")
    return {"days": db.written_days(user.uid, month)}


# --- Daybook ------------------------------------------------------------------


@app.post("/api/entries/{date}/reflect")
async def reflect(date: str, user: User = CurrentUser) -> dict:
    """Daybook reads one day's writing and answers it once."""
    date = _check_date(date)
    entry = await run_in_threadpool(db.get_entry, user.uid, date)
    if not entry or not entry["text"].strip():
        raise HTTPException(status_code=400, detail="Write something first.")
    if entry.get("reflection"):
        return {"reflection": entry["reflection"], "cached": True}

    await run_in_threadpool(_rate_limit, user.uid)
    # Only what existed by that day. Filling in an older entry should not
    # be answered with things written after it.
    past = await run_in_threadpool(db.list_entries, user.uid, limit=8, before=date)

    text = await journal.reflect(entry["text"], past, date)
    if text is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Daybook couldn't answer just now. Your writing is saved.",
        )

    await run_in_threadpool(db.set_reflection, user.uid, date, text, entry["revision"])
    return {"reflection": text, "cached": False}


@app.post("/api/entries/{date}/thread")
async def talk(date: str, body: ThreadBody, user: User = CurrentUser) -> dict:
    """The opt-in exchange about one entry."""
    date = _check_date(date)
    entry = await run_in_threadpool(db.get_entry, user.uid, date)
    if not entry:
        raise HTTPException(status_code=404, detail="There's no entry for that day.")

    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Write a message first.")
    await run_in_threadpool(_rate_limit, user.uid)
    request_id = str(body.request_id)
    cached = await run_in_threadpool(db.begin_turn, user.uid, date, request_id, message)
    if cached:
        return {"reply": cached}
    try:
        history = await run_in_threadpool(db.thread, user.uid, date)
        context_lines = [f"Their entry for {date}:\n{entry['text']}"]
        if entry.get("reflection"):
            context_lines.append(f"You already said:\n{entry['reflection']}")
        # The current input is already stored; do not repeat it in model context.
        context_lines += [f"{m['role']}: {m['text']}" for m in history[:-1][-6:]]
        reply = await ask(user.uid, message, "\n\n".join(context_lines))
        await run_in_threadpool(db.finish_turn, user.uid, date, request_id, reply)
        return {"reply": reply}
    except Exception:
        try:
            await run_in_threadpool(db.finish_turn, user.uid, date, request_id)
        except Exception:
            log.warning("Could not release conversation lease")
        log.exception("Thread reply failed")
        raise HTTPException(status_code=502, detail="Daybook didn't respond. Your message is kept; retry in a moment.")


@app.get("/api/opener")
async def get_opener(user: User = CurrentUser) -> dict:
    """Cached personal question, subject to the shared model-call budget."""
    entries = await run_in_threadpool(db.list_entries, user.uid, limit=5)
    signature = db.fingerprint(entries)
    cached = await run_in_threadpool(db.cached_opener, user.uid)
    if cached and cached.get("fingerprint") == signature:
        return {"opener": cached["opener"], "from": cached.get("from")}
    if entries:
        await run_in_threadpool(_rate_limit, user.uid)
    text = await journal.opener(entries)
    result = {"opener": text, "from": entries[-1]["date"] if entries else None}
    await run_in_threadpool(db.save_opener, user.uid, {**result, "fingerprint": signature})
    return result


@app.get("/api/insights")
async def get_insights(refresh: bool = False, day: str | None = None, user: User = CurrentUser) -> dict:
    """Patterns across the recent journal. Cached per day so reopening the
    tab is instant and doesn't re-bill the model."""
    today = _check_date(day) if day else date_type.today().isoformat()
    entries = await run_in_threadpool(db.list_entries, user.uid, limit=30)
    signature = db.fingerprint(entries)

    if not refresh:
        cached = await run_in_threadpool(db.cached_insights, user.uid, today)
        if cached and cached.get("fingerprint") == signature:
            cached.pop("created_at", None)
            cached.pop("fingerprint", None)
            return {"insights": cached, "cached": True}

    if len(entries) < 3:
        return {"insights": None, "reason": "not_enough_entries"}

    await run_in_threadpool(_rate_limit, user.uid)
    report = await journal.insights(entries)
    if report is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Couldn't read the patterns just now. Try again in a moment.",
        )

    await run_in_threadpool(db.save_insights, user.uid, today, {**report, "fingerprint": signature})
    return {"insights": report, "cached": False}


# --- Errors ----------------------------------------------------------------


@app.exception_handler(db.Conflict)
async def conflict_error(_request, exc):
    return JSONResponse(status_code=409, content={"detail": str(exc)})



@app.exception_handler(500)
async def internal_error(_request, _exc):
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong on our side."},
    )


# --- Interface -------------------------------------------------------------
# Mounted last so it never shadows /api or /healthz.

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse("static/index.html")
