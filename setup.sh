#!/usr/bin/env bash
# One-time project setup. Run once, before the first deploy.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-echo-journal}"
SA_NAME="${SERVICE}-sa"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "1/5  Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  identitytoolkit.googleapis.com \
  aiplatform.googleapis.com \
  --project "${PROJECT_ID}"

echo "2/5  Creating Firestore database (skip the error if it exists)"
gcloud firestore databases create --location="${REGION}" --project "${PROJECT_ID}" || true

echo "3/5  Creating the service account this app runs as"
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name "Ideathon app" --project "${PROJECT_ID}" || true

echo "4/5  Granting runtime data and model access"
for ROLE in roles/datastore.user roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SA}" --role "${ROLE}" --condition=None >/dev/null
done

echo "5/5  Storing the Gemini API key"
echo "     Paste the key from https://aistudio.google.com/apikey then press Ctrl-D"
SECRET_INPUT=$(mktemp)
trap 'rm -f "$SECRET_INPUT"' EXIT
cat > "$SECRET_INPUT"
if gcloud secrets describe gemini-api-key --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets versions add gemini-api-key --data-file="$SECRET_INPUT" --project "${PROJECT_ID}"
else
  gcloud secrets create gemini-api-key --data-file="$SECRET_INPUT" --project "${PROJECT_ID}"
fi

gcloud secrets add-iam-policy-binding gemini-api-key \
  --member "serviceAccount:${SA}" \
  --role roles/secretmanager.secretAccessor \
  --project "${PROJECT_ID}" >/dev/null

echo
echo "Done. Still to do by hand, in the Firebase console:"
echo "  - Add Firebase to project ${PROJECT_ID}"
echo "  - Authentication > Sign-in method > enable Google"
echo "  - Project settings > Your apps > add a Web app, copy the config into .env"
echo "  - Deploy, then add the Cloud Run URL under Authentication > Settings > Authorized domains"
