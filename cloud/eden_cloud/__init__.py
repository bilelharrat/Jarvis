"""Eden Cloud: hosted Eden Code runs (roadmap item 48), the server side.

A small service apart from the Mac app and from askeden.com's Worker: the Mac submits a run (a
git bundle of an isolated copy's branch, or a public git remote and branch, a brief, a model,
a budget and a time limit, and the owner's own Anthropic key), the service queues it, starts
one isolated container or VM for it on a pluggable backend (local Docker for development; Fly
Machines; stubs for Google Cloud and AWS), the runner in there clones the source, runs Claude
Code on the brief and sends its stream-json events back, then the branch it made comes back as
a git bundle and a diff for the Mac to review and land. Every run's workspace is deleted when
it ends; its events and result are kept a day for the Mac to fetch, then deleted too.

Who may use it: an Eden account (docs/accounts.md), by a short-lived Eden Cloud token
askeden.com signs (POST /api/cloud/token: Ed25519, audience eden-cloud) for a linked Mac. The
Mac's own device token never leaves for this service: only askeden.com ever sees it.

Cost policy: no model is called by the service. The agent in each run calls Anthropic with the
user's own key (bring your own key: Claude is BYOK for everyone but the owner), billed to them;
the service only caps what it may spend (Claude Code's --max-budget-usd, and the cost its
events report), and the minutes a user's runs may take, because the containers are the
owner's bill.

See cloud/README.md for running it and the owner's decisions before it can be deployed.
"""

__version__ = "0.1.0"
