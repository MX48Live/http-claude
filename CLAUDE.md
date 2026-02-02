# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

http-claude is an HTTP gateway that bridges web requests to the Claude CLI. It provides a web UI for chat and OpenAI-compatible API endpoints (`/v1/chat/completions`, `/v1/models`), enabling integration with tools like OpenCode.

**Runtime:** Bun (TypeScript, no compile step)
**Framework:** Hono v4

## Commands

```bash
bun run dev       # Start server with hot reload (--hot)
bun run start     # Start server normally
```

The server runs on `PORT` (default 3000). Set `MODEL_NAME` env var to change the model identifier exposed via the OpenAI-compatible API (default "claude-code").

There are no tests, linting, or CI configured.

## Architecture

The entire backend is in **server.ts** (~380 lines). The frontend is a self-contained React SPA in **public/index.html** (no build step, uses CDN-loaded React 18 + Babel).

### Request Flow

1. Web UI posts to `/api/chat` with `{ prompt, sessionId }`
2. Server spawns Claude CLI: `claude -p --output-format json [--resume SESSION_ID] PROMPT`
3. Parses JSON response, extracts `result` and `session_id`
4. Returns response and maintains session mapping

### Session Model

Sessions are stored **in-memory** (lost on restart). Each session maps a stable client-facing `sessionId` (UUID) to Claude CLI's internal `session_id` (used with `--resume` for multi-turn context).

### API Surface

- `GET /health` — health check
- `POST /api/sessions`, `GET /api/sessions`, `DELETE /api/sessions/:id`, `PATCH /api/sessions/:id` — session CRUD
- `POST /api/chat` — send message to Claude CLI
- `GET /v1/models` — OpenAI-compatible model list
- `POST /v1/chat/completions` — OpenAI-compatible chat (supports `stream: true` via SSE)

### OpenAI Compatibility Layer

The `/v1/chat/completions` endpoint converts OpenAI multi-role message arrays into a flat text prompt for Claude CLI. Streaming uses Server-Sent Events with chunked responses. Session keys for this endpoint are derived from a hash of the system prompt.

### Frontend

Single-file React app with inline CSS. Key behaviors: per-session loading states, client-side message caching via `useRef` Map, auto-naming sessions from the first user prompt, Enter to send / Shift+Enter for newline.
