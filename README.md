# Daybook — a journal that remembers

Daybook is a dated journal with a personal opening question, a short Gemini
reflection, optional conversation, and insights across the last 30 entries.
Built for the [Cloud Run AI Challenge](https://codelabs.developers.google.com/codelabs/cloud-run/cloud-run-ai-challenge).

## Stack and data

Python/FastAPI serves the static HTML/CSS/JavaScript interface. Firebase Google
sign-in supplies ID tokens, verified by the Firebase Admin SDK on every private
API. Firestore documents stay under `users/{uid}/entries/{YYYY-MM-DD}`. Existing
entries work without a migration. ADK handles the optional conversation.

Gemini runs through either Vertex AI (service-account credentials) or AI Studio
(a key injected from Secret Manager). `GOOGLE_GENAI_USE_VERTEXAI` selects the
provider. New installations default to AI Studio and `gemini-3.6-flash`.
**Redeploying an existing service preserves its existing provider, model, region,
Firebase values, service account, secrets, and scaling settings.**

The browser never receives model credentials. Journal text is processed on the
server and by Gemini; this is private account storage, not end-to-end encryption.

## Reliability and security

- A session generation invalidates late UI responses on account changes; day
  loads also have their own sequence. A failed save keeps the draft and prevents
  leaving that entry. Unsent chat drafts block day changes and sign-out.
- Saves are serialized in the browser and compare the stored text transactionally.
  Another tab's conflicting edit gets 409 instead of being overwritten.
- Reflections commit only against the entry revision they read. Deleted/edited
  entries reject obsolete responses. Existing documents gain revisions on edits.
- Chat requests have stable IDs: retries reuse the saved input and completed
  output. A per-entry lease prevents simultaneous model turns across instances.
- Firestore enforces a shared per-user model budget, including the opener.
  Openers are cached by entry content. Insights use the user's local day and
  content fingerprints, so changed writing invalidates stale cached results.
- Model calls have bounded waits and configured fallback models for recoverable
  errors. ADK sessions are deleted when each request finishes.
- Firestore reads use document-ID ranges; no data migration or composite index
  is needed. Timeline pagination and a date picker expose older writing on mobile.
- The supplied Firestore rules allow owner reads and route all writes through
  the authenticated backend. The backend bypasses rules using its service account.
- Dynamic journal/model output uses `textContent`. Private API responses use
  `Cache-Control: no-store`. No localStorage journal copies are created.

## Redeploy an existing service from Cloud Shell

Upload the **updated project files** to Cloud Shell first. Do not run these
commands against an older copy. You can upload the supplied source archive,
unzip it into a new directory, and enter that directory.

```bash
export PROJECT_ID="YOUR_EXISTING_PROJECT_ID"
export REGION="YOUR_EXISTING_CLOUD_RUN_REGION"
export SERVICE="YOUR_EXISTING_SERVICE_NAME"
gcloud config set project "$PROJECT_ID"
bash deploy.sh
```

For an existing service, this builds a **candidate revision with no production
traffic**. It retains deployed settings instead of trusting a stale `.env` file.
The script prints the candidate URL, the exact command to promote that revision,
and the exact rollback command for the previous traffic split. Save that output.

In Firebase Authentication → Settings → Authorized domains, add the candidate
URL's **hostname only**, without `https://` or a path. Open the candidate and run
the short acceptance walkthrough below. Only then run the printed PROMOTE
command. The regular service URL remains the submission URL.

If a new service is created, it has no previous traffic to preserve; it becomes
live after deployment and reads configuration from `.env`. Verify that you set
the existing service name correctly when redeploying.

The deployment script does not publish Firestore rules. After checking the
candidate uses server API writes, publish the supplied rules in the Firebase
console, or with Firebase CLI:

```bash
firebase deploy --only firestore:rules --project "$PROJECT_ID"
```

`firebase.json` is included. Do not run setup again just to redeploy. No secret
rotation, service-account role revocation, or database deletion is needed.

Reference: [Cloud Run deploy flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy).

## First-time setup only

Prerequisites: a billing-enabled Google Cloud project, gcloud CLI (provided by
Cloud Shell), Firebase console access, Python 3.12, and optionally Firebase CLI.

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="asia-south1"
export SERVICE="ideathon-app"
bash setup.sh
cp .env.example .env
```

`setup.sh` enables APIs, creates Firestore/the runtime identity, and stores a
Gemini API key. The runtime receives Firestore access and Vertex model access;
Secret Manager access is scoped to the model-key secret. Existing broad grants
are not automatically revoked during this submission fix.

Add Firebase to the same project. Enable Google under Authentication → Sign-in
method. Register a Web app and copy its public config into `.env`. Add the
Cloud Run hostname to Firebase Auth authorized domains after deploying. Do not
commit `.env` or service-account keys.

For Vertex, set `GOOGLE_GENAI_USE_VERTEXAI=TRUE` and a supported
`GOOGLE_CLOUD_LOCATION` in `.env` before the first deployment. Verify model
availability/billing in that project. Do not switch a working deployment's
provider solely to match an example configuration.

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # only if you do not already have .env
gcloud auth application-default login
uvicorn app.main:app --reload --port 8080
```

Fill `.env`, and add `localhost` to Firebase Auth authorized domains if needed.
Both Firestore and Vertex use Application Default Credentials locally. Model
keys are needed only for the AI Studio path. `/healthz` is liveness, not proof
that Firebase/model configuration is complete.

## Automated checks

No tests contact live Firebase, Gemini, Sheets, or Cloud Run. Backend tests use
synthetic identities and in-memory database doubles; UI tests execute the actual
JavaScript with a minimal DOM. The Cloud Run script test uses a fake gcloud.

```bash
pip install -r requirements-dev.txt
python -B -m unittest discover -s tests -v
node --test tests/frontend.test.cjs
```

Production dependencies are pinned to the versions used for these checks.
See `VERIFY.md` for the full walkthrough and `SECURITY.md` for the threat model.

## Candidate acceptance: before promoting

1. Google sign-in works and today's page loads without console errors.
2. Write, see Saved, get a reflection, send a reply, reload, and confirm both
   writing and the reply persist. An entry below 25 characters has Read this entry.
3. Open another date; confirm its writing and reflection belong to that date.
4. Use Timeline, Load older entries, and Open a day; repeat at phone width.
5. With three dated entries, open Insights, edit a source entry, reopen Insights,
   and verify refreshed content. Check Re-read my journal and appearance choices.
6. Sign out, sign in with another account, and confirm it sees none of the first
   account's text. Check `/api/entries` without a bearer token returns 401.
7. In browser DevTools, simulate offline while saving: draft stays, Retry save
   appears, and navigation is blocked. Reconnect and retry before signing out.

## Included Academy labs

`track1/`, `track2/`, and `track3/` are separate lab applications, excluded from
Daybook's deployment/image. Track 2's tool filter is corrected. Track 3 refuses
host shell execution when the sandbox is missing, isolates WebSocket sessions,
requires the literal `APPROVE` reply for sheet writes, restricts spreadsheet
writes to its configured TODO tab, and sanitizes Markdown output. Track 2/3
runbooks now deploy privately and use an authenticated Cloud Shell proxy.
These changes do not alter already deployed lab services; follow their runbooks
separately if those services are still in use.

## Submission

The campaign label is `dev-tutorial=cloud-run-ai-challenge`. Supply the working
URL or deployment walkthrough, accessible source repository, public project
showcase/write-up, and completed challenge form. These external deliverables
remain the participant's responsibility. Do not present a local test pass as
proof of cloud configuration, live model behavior, or organizer acceptance.
