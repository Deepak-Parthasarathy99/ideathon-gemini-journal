"""Settings, read once at boot from the environment."""

import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    project_id: str = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    firebase_project_id: str = os.getenv("FIREBASE_PROJECT_ID") or os.getenv(
        "GOOGLE_CLOUD_PROJECT", ""
    )

    model: str = os.getenv("MODEL", "gemini-3.6-flash")
    api_key: str = os.getenv("GOOGLE_API_KEY", "")

    # Two ways to reach the same models. AI Studio bills its own prepaid
    # credit pool; Vertex bills the Cloud project, which is where grant
    # credits live. Same code either way.
    use_vertex: bool = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "FALSE").upper() == "TRUE"
    location: str = os.getenv("GOOGLE_CLOUD_LOCATION", "global")
    fallback_models = tuple(m.strip() for m in os.getenv("FALLBACK_MODELS", "gemini-3.1-flash-lite,gemini-flash-latest,gemini-3.7-flash").split(",") if m.strip())
    model_timeout: float = float(os.getenv("MODEL_TIMEOUT_SECONDS", "55"))

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
        if not self.use_vertex and not self.api_key:
            gaps.append("GOOGLE_API_KEY")
        for name, value in (("FIREBASE_API_KEY", self.firebase_api_key), ("FIREBASE_AUTH_DOMAIN", self.firebase_auth_domain), ("FIREBASE_APP_ID", self.firebase_app_id)):
            if not value:
                gaps.append(name)
        return gaps


settings = Settings()
