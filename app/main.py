"""The one entry point. Serves the interface and the API from a single container.

Request path:
    browser -> verify Firebase ID token -> Firestore / Gemini

Cloud Run itself is deployed public so anyone can load the page. The app is
what refuses to do anything until a valid token shows up.
"""

import logging
from datetime import date as date_type

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, journal, limits
from .agent import ask
from .auth import CurrentUser, User
from .config import settings

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="Echo Journal", docs_url=None, redoc_url=None)


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


class ThreadBody(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


def _check_date(value: str) -> str:
    if not db.valid_date(value):
        raise HTTPException(status_code=400, detail="That isn't a date we understand.")
    return value


def _rate_limit(uid: str) -> None:
    if not limits.allow(uid, settings.rate_limit_per_minute):
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
def recent_entries(user: User = CurrentUser) -> dict:
    return {"entries": db.list_entries(user.uid, limit=30)}


@app.get("/api/entries/{date}")
def one_entry(date: str, user: User = CurrentUser) -> dict:
    date = _check_date(date)
    entry = db.get_entry(user.uid, date) or {"date": date, "text": "", "reflection": None}
    return {"entry": entry, "thread": db.thread(user.uid, date)}


@app.put("/api/entries/{date}")
def write_entry(date: str, body: EntryBody, user: User = CurrentUser) -> dict:
    """Autosave. Cheap, frequent, and it never calls the model."""
    date = _check_date(date)
    return {"entry": db.save_entry(user.uid, date, body.text.strip())}


@app.delete("/api/entries")
def clear_journal(user: User = CurrentUser) -> dict:
    return {"deleted": db.clear_journal(user.uid)}


@app.get("/api/calendar/{month}")
def calendar(month: str, user: User = CurrentUser) -> dict:
    """Which days in a 'YYYY-MM' month have writing."""
    if not db.valid_date(f"{month}-01"):
        raise HTTPException(status_code=400, detail="That isn't a month we understand.")
    return {"days": db.written_days(user.uid, month)}


# --- Echo ------------------------------------------------------------------


@app.post("/api/entries/{date}/reflect")
async def reflect(date: str, user: User = CurrentUser) -> dict:
    """Echo reads one day's writing and answers it once."""
    date = _check_date(date)
    entry = db.get_entry(user.uid, date)
    if not entry or not entry["text"].strip():
        raise HTTPException(status_code=400, detail="Write something first.")
    if entry.get("reflection"):
        return {"reflection": entry["reflection"], "cached": True}

    _rate_limit(user.uid)
    past = [e for e in db.list_entries(user.uid, limit=8) if e["date"] != date]

    text = await journal.reflect(entry["text"], past)
    if text is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Echo couldn't answer just now. Your writing is saved.",
        )

    db.set_reflection(user.uid, date, text)
    return {"reflection": text, "cached": False}


@app.post("/api/entries/{date}/thread")
async def talk(date: str, body: ThreadBody, user: User = CurrentUser) -> dict:
    """The opt-in exchange about one entry."""
    date = _check_date(date)
    entry = db.get_entry(user.uid, date)
    if not entry:
        raise HTTPException(status_code=404, detail="There's no entry for that day.")

    _rate_limit(user.uid)
    message = body.message.strip()

    history = db.thread(user.uid, date)
    context_lines = [f"Their entry for {date}:\n{entry['text']}"]
    if entry.get("reflection"):
        context_lines.append(f"You already said:\n{entry['reflection']}")
    context_lines += [f"{m['role']}: {m['text']}" for m in history[-6:]]

    db.add_thread_message(user.uid, date, "user", message)
    try:
        reply = await ask(user.uid, message, "\n\n".join(context_lines))
    except Exception:
        log.exception("Thread reply failed for uid=%s", user.uid)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Echo didn't respond. Try again in a moment.",
        )

    db.add_thread_message(user.uid, date, "assistant", reply)
    return {"reply": reply}


@app.get("/api/opener")
async def get_opener(user: User = CurrentUser) -> dict:
    """One personal question drawn from recent entries — never a blank page.

    Deliberately never fails: journal.opener falls back to a generic
    question on any model hiccup.
    """
    entries = db.list_entries(user.uid, limit=5)
    text = await journal.opener(entries)
    return {
        "opener": text,
        "from": entries[-1]["date"] if entries else None,
    }


@app.get("/api/insights")
async def get_insights(refresh: bool = False, user: User = CurrentUser) -> dict:
    """Patterns across the recent journal. Cached per day so reopening the
    tab is instant and doesn't re-bill the model."""
    today = date_type.today().isoformat()

    if not refresh:
        cached = db.cached_insights(user.uid, today)
        if cached:
            cached.pop("created_at", None)
            return {"insights": cached, "cached": True}

    entries = db.list_entries(user.uid, limit=30)
    if len(entries) < 3:
        return {"insights": None, "reason": "not_enough_entries"}

    _rate_limit(user.uid)
    report = await journal.insights(entries)
    if report is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Couldn't read the patterns just now. Try again in a moment.",
        )

    db.save_insights(user.uid, today, report)
    return {"insights": report, "cached": False}


# --- Errors ----------------------------------------------------------------


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
