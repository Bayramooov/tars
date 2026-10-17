# Stage 1: production dependencies (better-sqlite3 is native: prebuilt
# binaries normally, build tools as the fallback).
FROM node:24-bookworm-slim AS deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: runtime. Node runs src/*.ts directly (type stripping) — no build step.
FROM node:24-bookworm-slim

# tini is PID 1: it reaps zombies (Chromium, Claude Code's MCP children) and
# forwards SIGTERM to node, which shuts down gracefully.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini ca-certificates curl git && \
    rm -rf /var/lib/apt/lists/*

# The Claude Code CLI (also brings npx for npx-launched MCP plugins).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --from=deps /app/node_modules node_modules

# Headless Chromium for render_html/render_latex and the browser tools, at the
# version the installed playwright package expects, plus its system libraries.
RUN npx playwright install --with-deps chromium

COPY package.json ./
COPY src/ src/
COPY prompts/system.md prompts/subagents.md prompts/
COPY skills/ skills/

# Operator config: the example is always shipped; a real file is baked in only
# if present at build time, and the compose bind mounts override it at runtime.
COPY plugins.json.example plugins.json* ./
COPY access.json.example access.json* ./
COPY default-reminders.json.example default-reminders.json* ./

VOLUME /app/data

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.ts"]
