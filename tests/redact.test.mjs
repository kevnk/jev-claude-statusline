// Feeds secrets through a made-up transcript and checks none of them reach the request
// body. Run `node --test` from the repo root; it needs only node. The hook's fetch goes
// to a stub on 127.0.0.1 (see fetch-to-stub.mjs). JEV_HOOK=<path> tests another copy.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = process.env.JEV_HOOK || fileURLToPath(new URL("../hooks/jev-progress.mjs", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./fetch-to-stub.mjs", import.meta.url));

// Every key is joined from pieces at runtime, so no committed line looks like a real
// credential to GitHub push protection or a secret scanner.
const ALNUM = "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5";
const body = (n, alphabet = ALNUM) =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const j = (...parts) => parts.join("");
const S = {
  anthropic: j("sk-", "ant-", "api03-", body(93, ALNUM + "-_"), "AA"),
  openai: j("sk-", "proj-", body(120, ALNUM + "-_")),
  githubPat: j("github", "_pat_", body(22), "_", body(59)),
  githubOauth: j("gh", "o_", body(36)),
  aws: j("AK", "IA", body(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")),
  google: j("AI", "za", body(35, ALNUM + "-_")),
  slack: j("xo", "xb-", "1234567890-", "1234567890123-", body(24)),
  stripe: j("sk", "_live_", body(60)),
  jwt: j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "J", body(40), ".", body(43, ALNUM + "-_")),
  bearer: j("mF_9.B5f-", "4.1JqM", "xY7zQ2"),
  jsonValue: j("hunter2", "-correct-", "horse-battery"),
  urlPassword: j("hunter2", "pass"),
  queryToken: body(32),
};

const ANSWER = {
  answers: {
    phase: { score: 2, confidence: 0.9, probabilities: { 2: 0.9 } },
    done: { noul: 0.1 },
    waiting_on_user: { noul: 0.1 },
  },
  model: "jev-test",
  usage: { input_tokens: 1 },
};

const tmp = mkdtempSync(join(tmpdir(), "jev-redact-test-"));
const config = join(tmp, "config");
let server;
let stubUrl;
let requests;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(ANSWER));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${server.address().port}/`;
});
after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  requests = [];
});

function runHook(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, HOOK], {
      // A clean env, so a real TYPESAFE_API_KEY or ~/.claude never comes into it.
      env: {
        PATH: process.env.PATH,
        HOME: join(tmp, "home"),
        CLAUDE_CONFIG_DIR: config,
        TYPESAFE_API_KEY: "test-key",
        JEV_TEST_STUB: stubUrl,
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}: ${stderr}`))));
    child.stdin.end(JSON.stringify(payload));
  });
}

const line = (entry) => JSON.stringify(entry);
const userText = (text) => line({ type: "user", message: { role: "user", content: text } });
const assistant = (...content) => line({ type: "assistant", message: { role: "assistant", content } });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

function writeTranscript(name, lines) {
  const file = join(tmp, `${name}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const cached = (sid) => JSON.parse(readFileSync(join(config, "cache", "jev-progress", `${sid}.json`), "utf8"));

// A partial leak counts: no 12-character run of any secret may reach TypeSafe.
function assertNoSecrets(sent) {
  for (const [name, secret] of Object.entries(S)) {
    for (let i = 0; i + 12 <= secret.length; i++) {
      const piece = secret.slice(i, i + 12);
      assert.ok(!sent.includes(piece), `part of ${name} (${piece}) reached TypeSafe: ${sent}`);
    }
  }
}

test("PostToolUse sends no secret from the task, the latest message or any tool", async () => {
  const transcript = writeTranscript("post", [
    userText(
      `Deploy with ANTHROPIC_API_KEY=${S.anthropic} and check ` +
        `https://kevin:${S.urlPassword}@dash.example.test/run?token=${S.queryToken}#frag`,
    ),
    assistant(
      { type: "text", text: "Starting." },
      toolUse("t1", "Bash", { command: `curl -H "x-api-key: ${S.anthropic}" https://api.example.test`, description: `Call the API with ${S.githubPat}` }),
    ),
    assistant(toolUse("t2", "Grep", { pattern: S.aws })),
    assistant(toolUse("t3", "WebFetch", { url: `https://user:${S.urlPassword}@api.example.test/v1/items?key=${S.google}&sig=abc#section` })),
    assistant(toolUse("t4", "mcp__slack__send_message", { channel: "C0123SECRET", text: `here is the token ${S.slack}` })),
    assistant(toolUse("t5", "WebSearch", { query: "acme merger terms before announcement" })),
    assistant(toolUse("t6", "Read", { file_path: "/repo/config/.env.local" })),
    assistant(
      { type: "text", text: `Set {"client_secret": "${S.jsonValue}"} and Authorization: Bearer ${S.bearer}. JWT ${S.jwt}, ${S.openai}, ${S.githubOauth}.` },
    ),
  ]);
  await runHook({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    prompt_id: "p1",
    transcript_path: transcript,
    tool_name: "mcp__gmail__send_message",
    tool_input: { to: "someone@example.test", body: `card on file, key ${S.stripe}` },
    tool_use_id: "t7",
  });

  assert.equal(requests.length, 1, "the hook should make exactly one request, to the stub");
  assert.equal(requests[0].auth, "Bearer test-key");
  const { state } = requests[0].body;
  const sent = JSON.stringify(state);
  assertNoSecrets(sent);
  for (const leak of ["token=", "#frag", "sig=abc", "#section", "acme merger", "C0123SECRET", "here is the token", "someone@example.test", "card on file", "curl -H"]) {
    assert.ok(!sent.includes(leak), `"${leak}" reached TypeSafe: ${sent}`);
  }

  // What Jev still needs to judge progress is kept.
  assert.ok(state.task.startsWith("Deploy with ANTHROPIC_API_KEY=[REDACTED] and check https://dash.example.test/run"), state.task);
  assert.deepEqual(state.activity, [
    { tool: "Bash", detail: "Call the API with [REDACTED]" },
    { tool: "Grep", detail: "[REDACTED]" },
    { tool: "WebFetch", detail: "https://api.example.test/v1/items" },
    { tool: "send_message", detail: "" },
    { tool: "WebSearch", detail: "" },
    { tool: "Read", detail: ".env.local" },
    { tool: "send_message", detail: "" },
  ]);
  assert.match(state.claude_latest_message, /"client_secret": "\[REDACTED\]"/);
  assert.match(state.claude_latest_message, /Authorization: Bearer \[REDACTED\]/);
});

test("Stop redacts last_assistant_message from the payload", async () => {
  const transcript = writeTranscript("stop", [userText("Rotate the deploy key"), assistant({ type: "text", text: "Working." })]);
  await runHook({
    hook_event_name: "Stop",
    session_id: "s2",
    prompt_id: "p2",
    transcript_path: transcript,
    last_assistant_message: `Done. The new key is ${S.anthropic}; the dashboard is https://x.example.test/r?code=${S.queryToken}.`,
  });
  assert.equal(requests.length, 1);
  const { state } = requests[0].body;
  assertNoSecrets(JSON.stringify(state));
  assert.equal(state.claude_latest_message, "Done. The new key is [REDACTED]; the dashboard is https://x.example.test/r");
  assert.equal(state.turn_status, "stopped");
});

test("UserPromptSubmit keeps the secret out of the cached task and sends nothing", async () => {
  await runHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "s3",
    prompt_id: "p3",
    prompt: `Use OPENAI_API_KEY=${S.openai} for the eval`,
  });
  assert.equal(requests.length, 0);
  const record = JSON.parse(readFileSync(join(config, "cache", "jev-progress", "s3.json"), "utf8"));
  assert.equal(record.task, "Use OPENAI_API_KEY=[REDACTED] for the eval");
});

test("the stub guard stops the hook when no stub is set", async () => {
  const child = spawn(process.execPath, ["--import", PRELOAD, "-e", "0"], {
    env: { PATH: process.env.PATH, HOME: join(tmp, "home") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(code, 0);
});

test("URL passwords holding a raw @ or # lose their whole user:password part", async () => {
  await runHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "s4",
    prompt_id: "p4",
    prompt: `Compare postgres://admin:p@${S.urlPassword}Tail@db.internal/app with mysql://root:ab#${S.urlPassword}Tail@db/app`,
  });
  assert.equal(cached("s4").task, "Compare postgres://db.internal/app with mysql://db/app");
});

test("a private key pasted into the prompt goes whole", async () => {
  const b64 = body(64, ALNUM + "+/");
  const pem = j("-----BEGIN ", "RSA PRIVATE KEY-----\n", b64, "\n", b64, "\n-----END ", "RSA PRIVATE KEY-----");
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s5", prompt_id: "p5", prompt: `Use JWT_SECRET="${pem}" here` });
  const { task } = cached("s5");
  assert.ok(!task.includes(b64.slice(0, 12)), task);
  assert.equal(task, 'Use JWT_SECRET="[REDACTED]" here');
});

test("a prompt with 300 KB of blank space doesn't stall the hook", async () => {
  const started = Date.now();
  await runHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "s6",
    prompt_id: "p6",
    prompt: `Fix it"token"${" ".repeat(150_000)}:${" ".repeat(150_000)}"x" and ${"a-".repeat(50_000)}`,
  });
  // An unbounded \s* in the lookbehinds made this take minutes.
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
