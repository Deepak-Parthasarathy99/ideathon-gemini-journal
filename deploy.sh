#!/usr/bin/env bash
# Deploy to Cloud Run. Run from the project root.
#
# One region everywhere. Mismatched regions produce errors that explain nothing.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-ideathon-app}"
SA="${SERVICE}-sa@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Deploying ${SERVICE} to ${REGION} in ${PROJECT_ID}"

gcloud run deploy "${SERVICE}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --service-account "${SA}" \
  --allow-unauthenticated \
  --labels "dev-tutorial=cloud-run-ai-challenge" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_GENAI_USE_VERTEXAI=FALSE,MODEL=${MODEL:-gemini-3.5-flash},FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN},FIREBASE_APP_ID=${FIREBASE_APP_ID}" \
  --set-secrets "GOOGLE_API_KEY=gemini-api-key:latest"

# --allow-unauthenticated is deliberate: judges must be able to open the URL.
# The app still refuses to do anything without a verified Firebase token.
