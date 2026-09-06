#!/usr/bin/env bash
# Existing services are staged without changing their current traffic or env.
set -euo pipefail
cd "$(dirname "$0")"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-echo-journal}"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == '(unset)' ]]; then
  echo 'Set PROJECT_ID to your Google Cloud project.' >&2; exit 1
fi
DEPLOY_STATE=$(mktemp)
DEPLOY_RESULT=$(mktemp)
trap 'rm -f "$DEPLOY_STATE" "$DEPLOY_RESULT"' EXIT
# Listing successfully distinguishes a missing service from denied access.
EXISTING=$(gcloud run services list --project "$PROJECT_ID" --region "$REGION" --filter="metadata.name=$SERVICE" --format='value(metadata.name)')
ARGS=(run deploy "$SERVICE" --source . --project "$PROJECT_ID" --region "$REGION" --labels dev-tutorial=cloud-run-ai-challenge --timeout 120)
if [[ -n "$EXISTING" ]]; then
  gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format=json > "$DEPLOY_STATE"
  ARGS+=(--no-traffic --tag candidate)
else
  # Only a NEW service consumes .env. Existing service config is preserved.
  if [[ -f .env ]]; then set -a; source .env; set +a; fi
  : "${FIREBASE_API_KEY:?Set FIREBASE_API_KEY in .env}"
  : "${FIREBASE_AUTH_DOMAIN:?Set FIREBASE_AUTH_DOMAIN in .env}"
  : "${FIREBASE_APP_ID:?Set FIREBASE_APP_ID in .env}"
  PROVIDER="${GOOGLE_GENAI_USE_VERTEXAI:-FALSE}"
  SA="${SERVICE_ACCOUNT:-${SERVICE}-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
  ARGS+=(--allow-unauthenticated --service-account "$SA" --max-instances 2)
  ARGS+=(--update-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-$PROJECT_ID},GOOGLE_GENAI_USE_VERTEXAI=${PROVIDER},GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-global},MODEL=${MODEL:-gemini-3.6-flash},FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN},FIREBASE_APP_ID=${FIREBASE_APP_ID}")
  if [[ "$PROVIDER" != TRUE && "$PROVIDER" != true ]]; then
    ARGS+=(--update-secrets GOOGLE_API_KEY=gemini-api-key:latest)
  fi
fi
gcloud "${ARGS[@]}"
gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format=json > "$DEPLOY_RESULT"
python3 - "$DEPLOY_STATE" "$DEPLOY_RESULT" "$PROJECT_ID" "$REGION" "$SERVICE" <<'PY'
import json,sys,shlex
old_path,new_path,project,region,service=sys.argv[1:]
new=json.load(open(new_path))
base=['gcloud','run','services','update-traffic',service,'--project',project,'--region',region]
print('\nService URL:',new['status']['url'])
if open(old_path).read().strip():
    old=json.load(open(old_path))
    candidate=next((t.get('url') for t in new['status'].get('traffic',[]) if t.get('tag')=='candidate'),None)
    revision=new['status']['latestReadyRevisionName']
    print('Candidate URL:',candidate or 'Find the candidate tag in Cloud Run')
    print('Current traffic is unchanged. Test the candidate before promoting.')
    print('For Google sign-in, add the candidate hostname to Firebase Auth authorized domains.')
    print('\nPROMOTE after testing:\n'+shlex.join(base+['--to-revisions',revision+'=100']))
    previous={}
    for item in old['status'].get('traffic',[]):
        if item.get('percent',0):
            name=item.get('revisionName') or old['status']['latestReadyRevisionName']
            previous[name]=previous.get(name,0)+item['percent']
    if previous:
        print('\nROLL BACK if needed:\n'+shlex.join(base+['--to-revisions',','.join(f'{k}={v}' for k,v in previous.items())]))
else:
    print('New service deployed. Add its hostname to Firebase Auth authorized domains and test sign-in.')
PY
