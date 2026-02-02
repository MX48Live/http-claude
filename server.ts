import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";

const PORT = Number(process.env.PORT) || 3000;
const MODEL_NAME = process.env.MODEL_NAME || "claude-code";

// In-memory session store
// claudeSessionId tracks the real session ID that Claude CLI assigns
const sessions = new Map<
  string,
  {
    name: string;
    createdAt: number;
    claudeSessionId: string | null;
    messages: { role: string; content: string }[];
  }
>();

function newSessionId(): string {
  return crypto.randomUUID();
}

const app = new Hono();

// ── Health ──
app.get("/health", (c) => c.text("ok"));

// ── Create session ──
app.post("/api/sessions", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = body.id || newSessionId();
  const name = body.name || "New Chat";
  if (!sessions.has(id)) {
    sessions.set(id, { name, createdAt: Date.now(), claudeSessionId: null, messages: [] });
  }
  return c.json({ id, name });
});

// ── List sessions ──
app.get("/api/sessions", (c) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    id,
    name: s.name,
    createdAt: s.createdAt,
    messageCount: s.messages.length,
  }));
  list.sort((a, b) => b.createdAt - a.createdAt);
  return c.json(list);
});

// ── Delete session ──
app.delete("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  sessions.delete(id);
  return c.json({ ok: true });
});

// ── Rename session ──
app.patch("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const session = sessions.get(id);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json();
  if (body.name) session.name = body.name;
  return c.json({ ok: true });
});

// ── Chat ──
app.post("/api/chat", async (c) => {
  let prompt: string;
  let sessionId: string | null;

  try {
    const body = await c.req.json();
    prompt = body.prompt;
    sessionId = body.sessionId || null;
    if (!prompt) throw new Error("missing prompt");
  } catch {
    return c.json(
      { error: 'Send JSON: { "prompt": "...", "sessionId": "..." }' },
      400
    );
  }

  // Resolve or create session
  let session = sessionId ? sessions.get(sessionId) : null;
  const isNew = !session || !session.claudeSessionId;
  if (!session) {
    sessionId = sessionId || newSessionId();
    session = { name: "New Chat", createdAt: Date.now(), claudeSessionId: null, messages: [] };
    sessions.set(sessionId, session);
  }

  // Record user message
  session.messages.push({ role: "user", content: prompt });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`📨 INCOMING REQUEST`);
  console.log(`   Our Session:    ${sessionId}`);
  console.log(`   Claude Session: ${session.claudeSessionId || "(new)"}`);
  console.log(`   Prompt:         ${prompt}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Build claude command
  const args = ["claude", "-p", "--output-format", "json"];

  if (!isNew && session.claudeSessionId) {
    // Continue with Claude's real session ID
    args.push("--resume", session.claudeSessionId);
  }
  // For new sessions, don't pass --session-id — let Claude assign its own

  args.push(prompt);

  console.log(`🚀 SPAWNING: ${args.join(" ")}`);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  console.log(`\n📥 CLAUDE RESPONSE (exit: ${exitCode})`);
  console.log(`   stdout length: ${stdout.length} chars`);
  if (stderr) console.log(`   stderr: ${stderr}`);
  console.log(`   raw stdout: ${stdout}`);

  if (exitCode !== 0) {
    let errorMsg = stderr;
    if (!errorMsg) {
      try {
        const parsed = JSON.parse(stdout);
        errorMsg = parsed.result || stdout;
      } catch {
        errorMsg = stdout || "claude process failed";
      }
    }
    console.log(`❌ ERROR: ${errorMsg}`);
    session.messages.push({ role: "error", content: errorMsg });

    const lowerErr = errorMsg.toLowerCase();
    const isAuthError =
      lowerErr.includes("not authenticated") ||
      lowerErr.includes("authentication") ||
      lowerErr.includes("api key") ||
      lowerErr.includes("unauthorized") ||
      lowerErr.includes("login") ||
      lowerErr.includes("oauth") ||
      lowerErr.includes("sign in") ||
      lowerErr.includes("not logged in");

    if (isAuthError) {
      return c.json(
        {
          error: errorMsg,
          exitCode,
          sessionId,
        },
        401
      );
    }

    return c.json(
      { error: errorMsg, exitCode, sessionId },
      502
    );
  }

  // Parse JSON output to extract the result and session_id
  let resultText = stdout;
  try {
    const parsed = JSON.parse(stdout);
    console.log(`   parsed JSON keys: ${Object.keys(parsed).join(", ")}`);
    console.log(`   session_id from claude: ${parsed.session_id || "N/A"}`);
    console.log(`   cost_usd: ${parsed.cost_usd ?? "N/A"}`);
    console.log(`   duration_ms: ${parsed.duration_ms ?? "N/A"}`);
    resultText = parsed.result || stdout;

    // Detect auth errors returned inside a successful exit code
    if (parsed.is_error && typeof resultText === "string") {
      const lowerResult = resultText.toLowerCase();
      if (
        lowerResult.includes("invalid api key") ||
        lowerResult.includes("api key") ||
        lowerResult.includes("/login") ||
        lowerResult.includes("not authenticated") ||
        lowerResult.includes("unauthorized") ||
        lowerResult.includes("authentication") ||
        lowerResult.includes("sign in") ||
        lowerResult.includes("not logged in")
      ) {
        console.log(`❌ AUTH ERROR (in result): ${resultText}`);
        session.messages.push({ role: "error", content: resultText });
        return c.json(
          {
            error: resultText,
            sessionId,
          },
          401
        );
      }
    }

    // Store Claude's real session ID for future --resume calls
    if (parsed.session_id) {
      if (session.claudeSessionId !== parsed.session_id) {
        console.log(`   🔗 Claude session ID stored: ${parsed.session_id}`);
      }
      session.claudeSessionId = parsed.session_id;
    }
  } catch {
    console.log(`   ⚠️  stdout is not JSON, using raw text`);
  }

  const preview = resultText.length > 200 ? resultText.slice(0, 200) + "..." : resultText;
  console.log(`\n📤 SENDING TO CLIENT`);
  console.log(`   Session:  ${sessionId}`);
  console.log(`   Response: ${preview}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  session.messages.push({ role: "assistant", content: resultText });

  // Auto-name the session from the first user message
  if (session.name === "New Chat") {
    session.name = prompt.length > 50 ? prompt.slice(0, 50) + "..." : prompt;
  }

  // Return our stable sessionId (not Claude's internal one)
  return c.json({ sessionId, result: resultText });
});

// ── OpenAI-compatible: GET /v1/models ──
app.get("/v1/models", (c) => {
  return c.json({
    object: "list",
    data: [
      {
        id: MODEL_NAME,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "claude-cli",
      },
    ],
  });
});

// ── OpenAI-compatible: POST /v1/chat/completions ──
app.post("/v1/chat/completions", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { message: "Invalid JSON", type: "invalid_request_error" } },
      400
    );
  }

  const messages: { role: string; content: any }[] = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json(
      { error: { message: "messages array is required", type: "invalid_request_error" } },
      400
    );
  }

  const stream = body.stream === true;

  // Build prompt from messages: combine system + conversation history
  const promptParts: string[] = [];
  for (const msg of messages) {
    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n")
        : "";
    if (!text) continue;

    if (msg.role === "system") {
      promptParts.push(`[System]: ${text}`);
    } else if (msg.role === "user") {
      promptParts.push(`[User]: ${text}`);
    } else if (msg.role === "assistant") {
      promptParts.push(`[Assistant]: ${text}`);
    } else if (msg.role === "tool") {
      promptParts.push(`[Tool Result]: ${text}`);
    }
  }
  const prompt = promptParts.join("\n\n");

  // Look up or create a session keyed by a hash of the system prompt (if any)
  const systemMsg = messages.find((m) => m.role === "system");
  const sessionKey = systemMsg
    ? `oai-${Buffer.from(typeof systemMsg.content === "string" ? systemMsg.content : "").toString("base64").slice(0, 32)}`
    : null;
  let session = sessionKey ? sessions.get(sessionKey) : null;
  const isNew = !session || !session.claudeSessionId;
  if (!session) {
    session = { name: "OpenAI-compat", createdAt: Date.now(), claudeSessionId: null, messages: [] };
    if (sessionKey) sessions.set(sessionKey, session);
  }

  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || MODEL_NAME;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`📨 OpenAI-COMPAT REQUEST (stream=${stream})`);
  console.log(`   Model:          ${model}`);
  console.log(`   Messages:       ${messages.length}`);
  console.log(`   Claude Session: ${session.claudeSessionId || "(new)"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Build claude command
  const args = ["claude", "-p", "--output-format", "json"];
  if (!isNew && session.claudeSessionId) {
    args.push("--resume", session.claudeSessionId);
  }
  args.push(prompt);

  console.log(`🚀 SPAWNING: ${args.join(" ").slice(0, 200)}...`);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  console.log(`📥 CLAUDE RESPONSE (exit: ${exitCode}), stdout: ${stdout.length} chars`);
  console.log(`   raw stdout: ${stdout}`);

  if (exitCode !== 0) {
    let errorMsg = stderr;
    if (!errorMsg) {
      try {
        const parsed = JSON.parse(stdout);
        errorMsg = parsed.result || stdout;
      } catch {
        errorMsg = stdout || "claude process failed";
      }
    }

    const lowerErr = errorMsg.toLowerCase();
    const isAuthError =
      lowerErr.includes("not authenticated") ||
      lowerErr.includes("authentication") ||
      lowerErr.includes("api key") ||
      lowerErr.includes("unauthorized") ||
      lowerErr.includes("login") ||
      lowerErr.includes("oauth") ||
      lowerErr.includes("sign in") ||
      lowerErr.includes("not logged in");

    if (isAuthError) {
      return c.json(
        {
          error: {
            message: errorMsg,
            type: "authentication_error",
            code: exitCode,
          },
        },
        401
      );
    }

    return c.json(
      { error: { message: errorMsg, type: "server_error", code: exitCode } },
      502
    );
  }

  // Parse Claude's response
  let resultText = stdout;
  try {
    const parsed = JSON.parse(stdout);
    resultText = parsed.result || stdout;

    // Detect auth errors returned inside a successful exit code
    if (parsed.is_error && typeof resultText === "string") {
      const lowerResult = resultText.toLowerCase();
      if (
        lowerResult.includes("invalid api key") ||
        lowerResult.includes("api key") ||
        lowerResult.includes("/login") ||
        lowerResult.includes("not authenticated") ||
        lowerResult.includes("unauthorized") ||
        lowerResult.includes("authentication") ||
        lowerResult.includes("sign in") ||
        lowerResult.includes("not logged in")
      ) {
        console.log(`❌ AUTH ERROR (in result): ${resultText}`);
        return c.json(
          {
            error: {
              message: resultText,
              type: "authentication_error",
            },
          },
          401
        );
      }
    }

    if (parsed.session_id) {
      session.claudeSessionId = parsed.session_id;
    }
  } catch {
    // use raw stdout
  }

  // ── Non-streaming response ──
  if (!stream) {
    // Rough token estimate (1 token ≈ 4 chars)
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(resultText.length / 4);
    return c.json({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: resultText },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  }

  // ── Streaming response (SSE) ──
  return streamSSE(c, async (sseStream) => {
    // First chunk: role
    await sseStream.writeSSE({
      data: JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
    });

    // Stream content in chunks
    const CHUNK_SIZE = 20;
    let offset = 0;
    while (offset < resultText.length) {
      const chunk = resultText.slice(offset, offset + CHUNK_SIZE);
      await sseStream.writeSSE({
        data: JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        }),
      });
      offset += CHUNK_SIZE;
    }

    // Final chunk: finish_reason
    await sseStream.writeSSE({
      data: JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    });

    // [DONE] signal
    await sseStream.writeSSE({ data: "[DONE]" });
  });
});

// ── Static files ──
app.use("/*", serveStatic({ root: "./public" }));

export default {
  port: PORT,
  fetch: app.fetch,
};
