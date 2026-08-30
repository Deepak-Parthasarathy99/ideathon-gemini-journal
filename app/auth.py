"""Firebase Auth: proves who is calling, on every request that matters.

The Cloud Run service itself is public so a stranger can open the page.
Nothing past this module is reachable without a valid Firebase ID token.
"""

import firebase_admin
from fastapi import Depends, HTTPException, Request, status
from firebase_admin import auth as firebase_auth

from .config import settings

# Uses the service account Cloud Run runs as. No key file involved.
if not firebase_admin._apps:
    firebase_admin.initialize_app(options={"projectId": settings.firebase_project_id})


class User:
    def __init__(self, claims: dict):
        self.uid: str = claims["uid"]
        self.email: str | None = claims.get("email")
        self.name: str | None = claims.get("name")
        self.picture: str | None = claims.get("picture")

    def as_dict(self) -> dict:
        return {
            "uid": self.uid,
            "email": self.email,
            "name": self.name,
            "picture": self.picture,
        }


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to continue.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


def current_user(request: Request) -> User:
    """FastAPI dependency. Put this on every route that touches data or the model."""
    token = _bearer_token(request)
    try:
        claims = firebase_auth.verify_id_token(token)
    except Exception:
        # Expired, tampered with, or issued by a different project.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session expired. Sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return User(claims)


CurrentUser = Depends(current_user)
