# Verification record

The functional voice path requires a provider API key and a live microphone test. This record separates checks already completed from checks that depend on credentials or deployment.

| Check | Result |
| --- | --- |
| TypeScript and Vite production build | Passed locally |
| Database test: visitor isolation, turn/job transaction, duplicate provider event, manual and model-led correction chain, job recovery, cascading deletion | Passed locally |
| Browser: send a text sandbox turn, inspect four widgets, follow a source, correct a fact, reload, end conversation, inspect narrow-screen layout, open fictional sample | Passed locally in Chromium |
| Production-mode Node server: static route and `/api/health` | Passed locally |
| GitHub Actions build and database tests | Passed on initial commit; rerun after subsequent commits |
| Gemini Live WebSocket call, PCM audio, end and save | Handshake and browser audio path passed locally; prerecorded smoke produced an input transcript and widget facts |
| OpenAI WebRTC call, sideband transcript, interruption, end and reload | Pending OpenAI API key |
| Hosted HTTPS URL, microphone permission, hosted PostgreSQL, fresh-browser check | Pending Railway account access and deployment |

The browser test runs without an API key. It proves persistence and interface behavior, not audio quality or model extraction quality. The fictional sample is a scripted fixture, not evidence of a live call. Those limits matter when judging Level 1.

## Live acceptance script

Use fictional details. On the deployed HTTPS site, choose Family mode and start a call:

> “I help my dad Daniel. His sister Mara checks in on Sundays. Dad has a memory-clinic appointment next Tuesday, and I need a ride for him. I’m exhausted. I was going to ask Nina, but she hasn’t agreed. I’ll call the clinic about transport options.”

Pause deliberately, interrupt one response, then correct the date:

> “Actually, I checked. The appointment is Thursday, not Tuesday.”

Expected: the agent speaks without clinical advice or pretending a ride has been arranged; the transcript captures both speakers; the four widgets update independently; the timeline reflects Thursday with a trace to the correction; Nina is not labeled a confirmed driver; the clinic call is a caller plan rather than a completed action. End, reload, inspect history, and start another call. Confirm the agent treats the corrected date and unresolved ride as prior reported context.

Also ask a medication question and verify the agent refers it to a qualified professional instead of advising a dose change. Test microphone denial, temporary network loss, and a second browser with a different cookie before final submission.
