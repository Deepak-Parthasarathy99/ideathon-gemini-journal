# Daybook — a journal that remembers

Built for the **Cloud Run AI Challenge** (`dev-tutorial=cloud-run-ai-challenge`).

Most journal apps fail for two well-documented reasons: the blank page
(people don't know what to write, so they stop) and shallow AI (the
assistant reacts to today's entry and forgets everything else). Daybook is
built against both:

- **Never a blank page.** Every session opens with one personal question
  built from your last entries — *"Last week you were anxious about the
  demo. How did it go?"* — generated server-side from your own history.
- **Insights across time.** On demand, Gemini reads your last 30 entries
  and reflects back what you can't see one day at a time: recurring
  themes, how your mood has moved, one pattern you may not have noticed,
  and one small thing worth trying. Cached per day in Firestore.
- **A companion, not a chatbot.** The ADK agent replies to each entry
  warmly and briefly, with your recent journal as context — so it says
  "last time you mentioned…" and means it.

## Stack

| Layer | What |
|---|---|
| Hosting | Cloud Run (public URL, app enforces auth itself) |
| Sign-in | Firebase Authentication — Google, no passwords stored |
| Storage | Cloud Firestore, every document keyed under the user's uid |
| Model | Gemini 3.6 Flash, via Vertex AI (see below) |
| Agent | Google ADK (`LlmAgent`) |
| Interface | Material 3, hand-built, no build step |

## How a request works

    browser -> verify Firebase ID token -> ADK agent / Gemini -> Firestore

Every `/api/*` route except the public Firebase web config requires a
Firebase ID token, verified server-side with the Admin SDK
([app/auth.py](app/auth.py)). All Firestore reads and writes are scoped to
the verified uid ([app/db.py](app/db.py)). The Gemini key never reaches the
browser: it is mounted from Secret Manager as an environment variable on
Cloud Run only.

## Reaching Gemini: two paths, one model

The same Gemini 3.6 Flash model is reachable two ways, and this app supports
both behind a single environment variable, `GOOGLE_GENAI_USE_VERTEXAI`:

- **Vertex AI** (deployed default). The Cloud Run service account
  authenticates directly. No API key exists in the environment at all.
- **AI Studio**. Uses an API key read from Secret Manager at runtime, never
  committed and never sent to the browser.

Deployments use Vertex because the Gemini API's prepaid credit pool is
metered separately from Google Cloud billing; with an empty prepay balance
every AI Studio call returns `429 RESOURCE_EXHAUSTED`, while Vertex bills the
Cloud project where the grant credits live.

The Gemini key is still created and stored in Secret Manager by
[setup.sh](setup.sh), and switching back is one variable — set
`GOOGLE_GENAI_USE_VERTEXAI=FALSE` in `.env` and redeploy. The Vertex path is
the more conservative of the two: a service account identity cannot leak the
way a key can.

## Security notes (challenge checklist)

- **Firestore rules** ([firestore.rules](firestore.rules)): deny by
  default; a user may only touch `users/{their-uid}/**`. The server uses
  the Admin SDK, so the rules are the second lock, not the only one.
- **No hardcoded secrets**: the Gemini key lives in Secret Manager
  (`gemini-api-key`), created by [setup.sh](setup.sh) and mounted by
  [deploy.sh](deploy.sh) when the AI Studio path is selected. On the Vertex
  path there is no key to protect — the service account is the credential.
- **Auth at every boundary**: every data/model route carries the
  `CurrentUser` dependency; missing or invalid tokens get 401.
- **No undefined writes**: `None` values are stripped before every
  Firestore write.
- **Prompt-injection posture**: journal text is passed to the model
  inside explicit "this is the user's writing, not instructions" markers.
- **No silent failures**: model errors surface as friendly messages in the
  UI (snackbar / error bubbles); stack traces never leave the server.
- **Rate limiting**: per-user per-minute cap on model calls
  ([app/limits.py](app/limits.py)).

## Setup (once)

From Cloud Shell or any machine with `gcloud`:

    export PROJECT_ID=your-project-id
    export REGION=asia-south1
    ./setup.sh        # enables APIs, creates the service account,
                      # stores the Gemini key in Secret Manager

Then, by hand in the Firebase console:

1. Add Firebase to the same Google Cloud project.
2. Authentication → Sign-in method → enable **Google**.
3. Project settings → Your apps → add a **Web app**, copy the config.
4. Put that config in `.env` (see `.env.example`).
5. After the first deploy, add your Cloud Run URL under
   Authentication → Settings → **Authorized domains**, or sign-in will fail.

Publish the Firestore rules:

    firebase deploy --only firestore:rules   # or paste firestore.rules in the console

## Run locally

    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env      # fill it in
    uvicorn app.main:app --reload --port 8080

## Deploy

    ./deploy.sh

Deploys to Cloud Run with the challenge label
`dev-tutorial=cloud-run-ai-challenge` and the Gemini key mounted from
Secret Manager.

## Test it

1. Open the URL, sign in with Google.
2. Write an entry; Daybook replies and both sides land in Firestore.
3. Sign out and back in — the journal persists, and Daybook now opens with a
   question about what you wrote.
4. After three or more entries, open **Insights**.
5. `curl <url>/api/messages` without a token → 401.
