"""The one entry point. Serves the interface and the API from a single container.

Request path:
    browser -> verify Firebase ID token -> agent -> Firestore / Gemini

Cloud Run itself is deployed public so anyone can load the page. The app is
what refuses to do anything until a valid token shows up.
"""

import logging
from datetime import date

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


# --- API -------------------------------------------------------------------


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


@app.get("/api/me")
def me(user: User = CurrentUser) -> dict:
    db.touch_user(user.uid, user.email, user.name)
    return user.as_dict()


@app.get("/api/messages")
def get_messages(user: User = CurrentUser) -> dict:
    return {"messages": db.recent_messages(user.uid)}


@app.delete("/api/messages")
def delete_messages(user: User = CurrentUser) -> dict:
    return {"deleted": db.clear_messages(user.uid)}


@app.post("/api/chat")
async def chat(body: ChatRequest, user: User = CurrentUser) -> dict:
    if not limits.allow(user.uid, settings.rate_limit_per_minute):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="You're sending messages faster than we can answer. Wait a moment.",
        )

    message = body.message.strip()

    # Continuity is the product: the companion sees the recent transcript
    # (multi-turn feel) and the last few journal entries before this one.
    recent = db.recent_messages(user.uid, limit=10)
    past = db.user_entries(user.uid, limit=5)
    context_lines = [
        f"[{(e['created_at'] or '')[:10]}] they wrote: {e['text']}" for e in past
    ] + [f"{m['role']}: {m['text']}" for m in recent[-6:]]
    context = "\n".join(context_lines)

    db.add_message(user.uid, "user", message)

    try:
        reply = await ask(user.uid, message, context)
    except Exception:
        # Never leak a stack trace to the browser.
        log.exception("Agent failed for uid=%s", user.uid)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The assistant didn't respond. Try again in a moment.",
        )

    db.add_message(user.uid, "assistant", reply)
    return {"reply": reply}


# --- The two features beyond the baseline ----------------------------------


@app.get("/api/opener")
async def get_opener(user: User = CurrentUser) -> dict:
    """One personal question to start the session — never a blank page.

    Deliberately never fails: journal.opener falls back to a generic
    question on any model hiccup.
    """
    entries = db.user_entries(user.uid, limit=5)
    return {"opener": await journal.opener(entries), "has_history": bool(entries)}


@app.get("/api/insights")
async def get_insights(refresh: bool = False, user: User = CurrentUser) -> dict:
    """Patterns across the recent journal. Cached per day so reopening the
    tab is instant and doesn't re-bill the model."""
    today = date.today().isoformat()

    if not refresh:
        cached = db.cached_insights(user.uid, today)
        if cached:
            cached.pop("created_at", None)
            return {"insights": cached, "cached": True}

    entries = db.user_entries(user.uid, limit=30)
    if len(entries) < 3:
        return {"insights": None, "reason": "not_enough_entries"}

    if not limits.allow(user.uid, settings.rate_limit_per_minute):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests. Wait a moment.",
        )

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
