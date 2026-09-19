# Harbor — a voice care navigator

Harbor is a patient- and family-facing AI voice navigator. It listens through a browser call, keeps a persistent transcript, and updates four independent live views: the care circle, care timeline, needs and questions, and next steps. Each extracted detail links to the turn that supports it. A person can correct a detail, review what changed over the session, or delete the conversation.

Harbor is **non-clinical**. It does not diagnose, advise medication changes, or claim that appointments, rides, or follow-ups were arranged. The interface identifies it as AI. Use fictional or de-identified information for a demo; this prototype is not a production clinical record system.

## Run locally

Requires Node 22+ and an OpenAI API key for voice. `DATABASE_URL` is optional locally: without it, data persists in `./data` using PGlite. With it, Harbor uses PostgreSQL.

```bash
npm ci
cp .env.example .env
# Set OPENAI_API_KEY in .env; optionally set DATABASE_URL
npm run dev
```

Open `http://localhost:3000`. Without an API key, **Open text sandbox** lets you inspect persistence and widgets, but there is no simulated voice agent. Microphone access requires a secure origin (localhost or HTTPS). No API key is sent to the browser.

## Deploy

The included Dockerfile runs the production Vite build and Fastify server on `$PORT`. Set `OPENAI_API_KEY` and a managed PostgreSQL `DATABASE_URL` in the hosting provider. Use one application instance for this prototype; live WebSocket subscribers and worker scheduling are process-local. Set `PGSSL=disable` only for a database connection that does not require TLS. Do not deploy with PGlite unless the host provides persistent storage.

On Railway, create a service from this repository, add a PostgreSQL service, map its connection string to `DATABASE_URL`, add the OpenAI key, and use the generated public domain. The health endpoint is `/api/health`.

## How it works

- React client uses WebRTC for the browser-to-OpenAI Realtime audio call. Fastify creates the call using the server-held API key and attaches a server-side monitoring WebSocket for finalized transcripts.
- A user turn, its event, and four analysis jobs are committed in one database transaction. Four widget lanes process each turn independently using structured model output; each job validates its source quote before saving a fact. The keyless text sandbox uses lightweight rule extraction for local inspection.
- PostgreSQL/PGlite store visitors, conversations, turns, facts, widget states, events, and jobs. A random HttpOnly visitor cookie scopes access. This is convenient for a demo, not a replacement for production authentication.
- Corrections preserve the original item as corrected, write a replacement linked to it, and reprocess all widgets. The replay slider reads persisted events. Deletion cascades through all conversation data.

## Checks

```bash
npm run build
npm test
node --import tsx tests/browser-smoke.ts # while local server runs
```

The automated checks cover stored turn/job atomicity, duplicate provider events, visitor isolation, correction history, cascading deletion, and a browser flow. A live voice call requires an OpenAI key and a browser microphone; verify it manually on the deployed URL before sharing the demo.

## Current limitations

This is an interview prototype. It has no account recovery, clinician workflow, formal audit/retention policy, multi-instance event fanout, or HIPAA-ready operating controls. Browser identity is tied to a cookie. Live voice and model extraction require the configured OpenAI account. The text sandbox is for testing persistence and widget behavior; it does not converse.
