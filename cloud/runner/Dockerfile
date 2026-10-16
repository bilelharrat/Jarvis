# The Eden Cloud runner image: one container (or Fly Machine, Cloud Run job, Fargate task) per
# run. Python, git and the Claude Code CLI; the runner script; a non-root user. No secrets are
# baked in: each run's environment brings its own (eden_runner.py).
#   docker build -t eden-cloud-runner:dev cloud/runner
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force
RUN useradd --uid 1000 --create-home --home-dir /home/runner runner 2>/dev/null \
 || (userdel -r node && useradd --uid 1000 --create-home --home-dir /home/runner runner)
COPY eden_runner.py /opt/eden/eden_runner.py
RUN mkdir -p /work && chown runner:runner /work
USER runner
WORKDIR /work
ENV HOME=/home/runner EDEN_RUN_WORK=/work
ENTRYPOINT ["python3", "/opt/eden/eden_runner.py"]
