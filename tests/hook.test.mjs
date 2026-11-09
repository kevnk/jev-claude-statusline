// Offline tests for what hooks/jev-progress.mjs sends, caches and skips. Run `node --test`
// from the repo root; it needs only node. See harness.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { GOOD_ANSWER, assistant, runHook, sandbox, startStub, text, toolUse, userText } from "./harness.mjs";

let stub;
let box;
before(async () => {
  stub = await startStub();
});
after(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
  stub.respond = () => ({ body: GOOD_ANSWER });
  box = sandbox();
});
afterEach(() => box.cleanup());

const run = (payload, env) => runHook(payload, { stub, box, env });
const prompt = (text, extra = {}) =>
  run({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", prompt: text, ...extra });
const postTool = (transcript, { env, ...extra } = {}) =>
  run({ hook_event_name: "PostToolUse", session_id: "s", prompt_id: "p1", transcript_path: transcript, ...extra }, env);
const simpleTranscript = () =>
  box.transcript("t", [userText("Fix the flaky login test"), assistant([text("Looking."), toolUse("t1", "Read", { file_path: "/r/login.test.ts" })])]);

test("UserPromptSubmit starts a fresh record and sends nothing", async () => {
  await prompt("Fix the flaky login test");
  const record = box.readRecord("s");
  assert.equal(typeof record.started_at, "number");
  delete record.started_at;
  assert.deepEqual(record, { session_id: "s", prompt_id: "p1", task: "Fix the flaky login test", turn_status: "working", samples: [] });
  assert.equal(stub.requests.length, 0);
});

test("text Claude Code injects is never taken as the task, but a slash command's args are", async () => {
  for (const injected of [
    "<system-reminder>context</system-reminder>",
    "[SYSTEM NOTIFICATION] a task finished",
    "Another Claude session sent a message: hi",
    '<teammate-message from="x">hi</teammate-message>',
    "   ",
  ]) {
    await prompt(injected);
    assert.equal(existsSync(join(box.cache, "s.json")), false, injected);
  }
  await prompt("<command-name>/review</command-name>\n<command-args>PR 12 only</command-args>");
  assert.equal(box.readRecord("s").task, "PR 12 only");
});

test("UserPromptSubmit prunes records older than a week", async () => {
  const old = join(box.cache, "old.json");
  const fresh = join(box.cache, "fresh.json");
  writeFileSync(old, "{}");
  writeFileSync(fresh, "{}");
  const eightDaysAgo = (Date.now() - 8 * 24 * 3600_000) / 1000;
  utimesSync(old, eightDaysAgo, eightDaysAgo);
  await prompt("anything");
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("PostToolUse asks Jev the three questions and caches the answer", async () => {
  await postTool(simpleTranscript());
  assert.equal(stub.requests.length, 1);
  const { auth, body } = stub.requests[0];
  assert.equal(auth, "Bearer test-key");
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), ["phase", "done", "waiting_on_user"]);
  assert.deepEqual(body.state, {
    task: "Fix the flaky login test",
    activity: [{ tool: "Read", detail: "login.test.ts" }],
    claude_latest_message: "Looking.",
    turn_status: "working",
  });

  const record = box.readRecord("s");
  assert.equal(record.progress, 0.5);
  assert.deepEqual(record.phase, { score: 2.5, confidence: 0.8, top_level: 2, label: "building" });
  assert.equal(record.done, 0.1);
  assert.equal(record.waiting_on_user, 0.2);
  assert.deepEqual(record.samples.map((s) => s.progress), [0.5]);
  assert.equal(record.model, "jev-test");
  assert.equal(record.input_tokens, 42);
  assert.equal(record.turn_status, "working");
});

test("a later evaluation keeps the start time, adds a sample and clears an old error", async () => {
  box.writeRecord("s", {
    session_id: "s",
    prompt_id: "p1",
    started_at: 1000,
    task: "Cached task text",
    turn_status: "working",
    samples: [{ t: 1, progress: 0.2 }],
    last_error: "HTTP 500 boom",
    last_error_at: 2,
  });
  await postTool(simpleTranscript());
  // The task cached for this prompt wins over the transcript's copy.
  assert.equal(stub.requests[0].body.state.task, "Cached task text");
  const record = box.readRecord("s");
  assert.equal(record.started_at, 1000);
  assert.deepEqual(record.samples.map((s) => s.progress), [0.2, 0.5]);
  assert.equal("last_error" in record, false);
  assert.equal("last_error_at" in record, false);
});

test("a task cached for another prompt is replaced by the transcript's", async () => {
  box.writeRecord("s", { prompt_id: "p0", task: "Old prompt", started_at: 1000, samples: [] });
  await postTool(simpleTranscript());
  assert.equal(stub.requests[0].body.state.task, "Fix the flaky login test");
});

test("with no key it records the error and sends nothing", async () => {
  await postTool(simpleTranscript(), { env: { TYPESAFE_API_KEY: undefined } });
  assert.equal(stub.requests.length, 0);
  const record = box.readRecord("s");
  assert.equal(record.last_error, "TYPESAFE_API_KEY not set");
  assert.equal(record.turn_status, "working");
});

test("the key can come from secrets/typesafe_api_key", async () => {
  mkdirSync(join(box.config, "secrets"));
  writeFileSync(join(box.config, "secrets", "typesafe_api_key"), "file-key\n");
  await postTool(simpleTranscript(), { env: { TYPESAFE_API_KEY: undefined } });
  assert.equal(stub.requests[0].auth, "Bearer file-key");
});

test("an HTTP error and an answer with no phase are recorded, not thrown", async () => {
  stub.respond = () => ({ status: 500, body: "  boom  " });
  await postTool(simpleTranscript());
  assert.equal(box.readRecord("s").last_error, "HTTP 500 boom");

  stub.respond = () => ({ body: { answers: {} } });
  await postTool(simpleTranscript());
  assert.equal(box.readRecord("s").last_error, "no phase answer in response");
});

test("Stop sends the stopped status and the payload's last message", async () => {
  await run({
    hook_event_name: "Stop",
    session_id: "s",
    prompt_id: "p1",
    transcript_path: simpleTranscript(),
    last_assistant_message: "Done. The test is fixed.",
  });
  const { state } = stub.requests[0].body;
  assert.equal(state.turn_status, "stopped");
  assert.equal(state.claude_latest_message, "Done. The test is fixed.");
  assert.equal(box.readRecord("s").turn_status, "stopped");
});

test("subagent and unknown events are ignored", async () => {
  await postTool(simpleTranscript(), { agent_id: "sub-1" });
  await run({ hook_event_name: "SessionStart", session_id: "s", prompt_id: "p1" });
  assert.equal(stub.requests.length, 0);
  assert.equal(existsSync(join(box.cache, "s.json")), false);
});

test("a held lock skips a PostToolUse, and a stale one is cleared", async () => {
  const lock = join(box.cache, "s.lock");
  mkdirSync(lock);
  await postTool(simpleTranscript());
  assert.equal(stub.requests.length, 0);

  const longAgo = (Date.now() - 60_000) / 1000;
  utimesSync(lock, longAgo, longAgo);
  await postTool(simpleTranscript());
  assert.equal(stub.requests.length, 1);
  assert.equal(existsSync(lock), false);
});

test("an answer that lands after a newer prompt doesn't overwrite it", async () => {
  let release;
  stub.respond = () => new Promise((resolve) => (release = () => resolve({ body: GOOD_ANSWER })));
  const hook = postTool(simpleTranscript());
  while (!release) await new Promise((r) => setTimeout(r, 10));
  const newer = { session_id: "s", prompt_id: "p2", started_at: Date.now() + 60_000, task: "Newer prompt", turn_status: "working", samples: [] };
  box.writeRecord("s", newer);
  release();
  await hook;
  assert.deepEqual(box.readRecord("s"), newer);
});

test("activity skips sidechain calls and keeps the last 15", async () => {
  const calls = Array.from({ length: 20 }, (_, i) => assistant([toolUse(`t${i}`, "Grep", { pattern: `p${i}` })]));
  await postTool(
    box.transcript("many", [
      userText("Old prompt"),
      userText("Find every caller"),
      userText("meta note", { isMeta: true }),
      ...calls,
      assistant([toolUse("side", "Grep", { pattern: "from a subagent" })], { isSidechain: true }),
    ]),
  );
  const { state } = stub.requests[0].body;
  assert.equal(state.task, "Find every caller");
  assert.deepEqual(state.activity.map((a) => a.detail), Array.from({ length: 15 }, (_, i) => `p${i + 5}`));
});
