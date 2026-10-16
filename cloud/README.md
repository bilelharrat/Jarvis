# Eden Cloud

Hosted Eden Code runs (roadmap item 48): a session goes from Eden Code on the Mac to a fresh,
isolated machine, Claude Code works on it there with the user's own Anthropic key, its events
stream back into the session, and its branch comes back as a git bundle and a diff to review and
land. Not deployed anywhere yet: hosting and billing are the owner's decisions (below).

- `eden_cloud/`: the API (Starlette). `app.py` routes, `service.py` queue, limits and machines,
  `auth.py` tokens, `store.py` SQLite and files, `backends.py` machines, `config.py` settings.
- `runner/`: what runs inside each machine (`eden_runner.py`, standard library only) and its
  image (`Dockerfile`: Python, git, the Claude Code CLI, a non-root user).
- `Dockerfile`: the API's image.
- The Mac's side: `src/jarvis/features/code_eden_cloud.py` and `web/features/code-eden-cloud.js`
  (Eden Code settings › Eden Cloud; a session's More menu › Run in Eden Cloud…). Off by default.
- askeden.com's side: `POST /api/cloud/token` (`site/src/accounts/cloud-token.js`,
  docs/accounts.md "Eden Cloud tokens").

## How a run goes

1. The Mac asks askeden.com for an Eden Cloud token (ten minutes, Ed25519; the Mac's device token
   never leaves for Eden Cloud). The card on the Mac says what leaves it; a secret scan runs first.
2. `POST /v1/runs` with the brief, model, budget, time limit, the user's key and the source: a git
   bundle of the isolated copy's branch (`PUT /v1/runs/<id>/source`), or a public https remote.
3. The service queues it and, within the limits, starts one machine with `EDEN_RUN_ID`,
   `EDEN_RUN_URL`, a one-run `EDEN_RUN_TOKEN` and `ANTHROPIC_API_KEY`. The key then leaves the
   service's memory (it's never written anywhere).
4. The runner fetches the job and code, runs `claude -p … --output-format stream-json
   --permission-mode bypassPermissions --max-budget-usd B`, and posts every line back. The Mac
   long-polls `GET /v1/runs/<id>/events?after=N&wait=20` and shows them in the session.
5. At the end it commits, uploads the branch past the starting commit as a bundle and the diff,
   and says done. The service stops the machine (deleting the workspace), deletes the source,
   and keeps events and result `EDEN_CLOUD_KEEP_HOURS` (24) for the Mac, then deletes the run.
6. The Mac fetches the bundle into the isolated copy and fast-forwards, unless the change touches
   a file that can run code on the Mac (hooks, `.claude/`, `.mcp.json`, CLAUDE.md…): then it
   stays parked under `refs/jarvis/eden-cloud/…` for the owner to look at.

The full API is in `eden_cloud/app.py`'s docstring.

## Limits (environment, per account unless said)

`EDEN_CLOUD_REQUIRE_PLAN` (`plus`; empty: any account), `EDEN_CLOUD_ACCOUNTS` (an allow-list),
`EDEN_CLOUD_MAX_RUNNING_PER_USER` (1), `EDEN_CLOUD_MAX_QUEUED_PER_USER` (3), `EDEN_CLOUD_MAX_RUNNING`
(4, the service's), `EDEN_CLOUD_MAX_MINUTES` (60 per run), `EDEN_CLOUD_DAILY_MINUTES` (180 per 24 h),
`EDEN_CLOUD_MAX_BUDGET_USD` (20 per run), `EDEN_CLOUD_DAILY_BUDGET_USD` (50 per 24 h of reported
cost), `EDEN_CLOUD_MAX_SOURCE_MB` (200), `EDEN_CLOUD_CPUS` (2), `EDEN_CLOUD_MEMORY_MB` (4096).
A run past its deadline is `timed_out`; past its budget (as its events report) `over_budget`.

## Running it on this Mac (development)

Needs Docker (not installed on the owner's Mac today). Never on ports 5174 or 8765.

    docker build -t eden-cloud-runner:dev cloud/runner
    cd cloud && EDEN_CLOUD_BACKEND=docker EDEN_CLOUD_DEV_TOKENS="<24+ chars>=<account uuid>" \
      EDEN_CLOUD_REQUIRE_PLAN= EDEN_CLOUD_PORT=8790 python -m eden_cloud

then in Eden Code settings › Eden Cloud: switch on, address `http://localhost:8790`, and start
Eden Code with `JARVIS_EDEN_CLOUD_TOKEN=<the same token>` (honoured only for a localhost address).

Tests (fakes only: no Docker, no cloud, no model):

    PYTHONPATH=cloud .venv/bin/python -m pytest -q cloud/tests
    PYTHONPATH=src .venv/bin/python -m pytest -q tests/test_code_eden_cloud.py
    cd site && node --test test/cloud-token.test.js

## Backends

| Backend | State | Notes |
| --- | --- | --- |
| `docker` | built, tested with a faked `docker` | development only; non-root, no capabilities, read-only root, tmpfs workspace, CPU/memory/pids caps, `--rm`; key by an env file deleted at once |
| `fly` | built to the Machines API, tested with a mock transport | one machine per run, `auto_destroy`; never run against Fly |
| `gcp` | stub | Cloud Run job per run (key better via Secret Manager) |
| `aws` | stub | ECS RunTask on Fargate |
| `fake` | tests | |

## Owner decisions before it can go live

1. **Where it's hosted** (the API and the machines): Fly Machines (closest to built), Google Cloud
   (Cloud Run jobs; the owner already has a GCP project), or AWS Fargate. Then a domain
   (e.g. `cloud.askeden.com`) and TLS in front of the API, and a persistent volume for its data.
2. **Who pays for the machines and who may use it**: today Plus only, 1 run at a time, 180
   minutes a day. Per-run compute is roughly cents per hour on Fly/Cloud Run at 2 vCPU/4 GB, but
   it's the owner's bill. Decide: Plus-only, a separate Eden Cloud add-on (Stripe/StoreKit), or
   metered minutes. The model is already the user's own key (BYOK).
3. **Network egress from runs**: open today (Claude Code needs Anthropic, and tests need package
   registries). An allow-list proxy is possible but decides what runs can install.
4. **Retention**: events and results kept 24 h, then deleted (privacy policy wording).
5. **The Ed25519 key**: generate it, put the private key in the Worker
   (`npx wrangler secret put EDEN_CLOUD_SIGNING_KEY`) and the public key in Eden Cloud
   (`EDEN_CLOUD_ASKEDEN_PUBLIC_KEY`). Deploying askeden.com ships `POST /api/cloud/token`.

## Security review needed (independent, before any public launch)

- The user's Anthropic key: sent in the submit body over TLS, held in memory, then in the
  machine's environment (Fly machine config is readable by anyone with the app's Fly token; the
  agent itself can read it, as it would on the user's own Mac). Consider a per-run
  Anthropic-key proxy so the machine never holds the raw key.
- The runner token (`ert1.…`, SHA-256 stored, dies at the end): readable by the agent through
  `/proc` (same user), so a run can forge its own events and result: harmless to others, but the
  Mac must keep treating everything from a run as untrusted (it does: risky files parked, words
  marked as data).
- Container escape and neighbour isolation: Docker alone isn't a strong boundary; production
  should use microVMs (Fly Machines are Firecracker; Cloud Run gen2 is gVisor) and no shared
  host network. The runner reaches the API by public URL only.
- Abuse: crypto-mining or attacks from runs (limits help; egress policy and a kill switch per
  account are owner steps), and bundle size/zip-bomb style inputs (caps on source, events, result).
- Token: audience, lifetime (≤ 15 min accepted), Mac-only, and plan claims; no revocation inside
  the ten minutes (signing out of askeden.com still leaves a minted token valid that long).
- The `git` remote source: only `https://` without credentials; still lets a run clone any
  public URL the user names.
