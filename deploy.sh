#!/usr/bin/env bash
# Deploy to Cloud Run. Run from the project root.
#
# One region everywhere. Mismatched regions produce errors that explain nothing.
set -euo pipefail

# Read .env if it's there, so the Firebase web config doesn't have to be
# exported by hand. Values already in the environment win.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-echo-journal}"
SA="${SERVICE}-sa@${PROJECT_ID}.iam.gserviceaccount.com"

# Vertex bills the Cloud project and authenticates as the service account,
# so no API key is mounted in that mode.
USE_VERTEX="${GOOGLE_GENAI_USE_VERTEXAI:-TRUE}"
LOCATION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
if [ "${USE_VERTEX}" = "TRUE" ]; then
  SECRET_FLAG=""
else
  SECRET_FLAG="--set-secrets=GOOGLE_API_KEY=gemini-api-key:latest"
fi

# Fail here, with a sentence that says what to do, rather than inside gcloud.
missing=""
for var in FIREBASE_API_KEY FIREBASE_AUTH_DOMAIN FIREBASE_APP_ID; do
  [ -z "${!var:-}" ] && missing="${missing} ${var}"
done
if [ -n "${missing}" ]; then
  echo "Missing Firebase web config:${missing}"
  echo "Get it from the Firebase console > Project settings > Your apps > Web app,"
  echo "then put it in .env (see .env.example). Sign-in cannot work without it."
  exit 1
fi

echo "Deploying ${SERVICE} to ${REGION} in ${PROJECT_ID}"

gcloud run deploy "${SERVICE}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --service-account "${SA}" \
  --allow-unauthenticated \
  --labels "dev-tutorial=cloud-run-ai-challenge" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_GENAI_USE_VERTEXAI=${USE_VERTEX},GOOGLE_CLOUD_LOCATION=${LOCATION},MODEL=${MODEL:-gemini-3.6-flash},FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN},FIREBASE_APP_ID=${FIREBASE_APP_ID}" \
  ${SECRET_FLAG}

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" \
  --project "${PROJECT_ID}" --format='value(status.url)')"

echo
echo "Live at: ${URL}"
echo
echo "Last step, or sign-in will fail:"
echo "  Firebase console > Authentication > Settings > Authorized domains"
echo "  Add: ${URL#https://}"

# --allow-unauthenticated is deliberate: judges must be able to open the URL.
# The app still refuses to do anything without a verified Firebase token.
