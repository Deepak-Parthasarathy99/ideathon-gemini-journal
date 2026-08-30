"""Settings, read once at boot from the environment."""

import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    project_id: str = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    firebase_project_id: str = os.getenv("FIREBASE_PROJECT_ID") or os.getenv(
        "GOOGLE_CLOUD_PROJECT", ""
    )

    model: str = os.getenv("MODEL", "gemini-3.5-flash")
    api_key: str = os.getenv("GOOGLE_API_KEY", "")

    rate_limit_per_minute: int = int(os.getenv("RATE_LIMIT_PER_MINUTE", "20"))

    # Firebase web config. Public by design — it identifies the project, it
    # does not grant access. Access is controlled by Auth and Firestore rules.
    firebase_api_key: str = os.getenv("FIREBASE_API_KEY", "")
    firebase_auth_domain: str = os.getenv("FIREBASE_AUTH_DOMAIN", "")
    firebase_app_id: str = os.getenv("FIREBASE_APP_ID", "")

    def web_config(self) -> dict:
        return {
            "apiKey": self.firebase_api_key,
            "authDomain": self.firebase_auth_domain,
            "projectId": self.firebase_project_id,
            "appId": self.firebase_app_id,
        }

    def missing(self) -> list[str]:
        """Config that must be present before the app can do anything useful."""
        gaps = []
        if not self.firebase_project_id:
            gaps.append("GOOGLE_CLOUD_PROJECT")
        if not self.api_key:
            gaps.append("GOOGLE_API_KEY")
        return gaps


settings = Settings()
