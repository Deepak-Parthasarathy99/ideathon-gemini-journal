"""Compatibility entry point for the shared, transactional model-call budget."""
from .db import allow_model


def allow(uid: str, per_minute: int) -> bool:
    return allow_model(uid, per_minute)
