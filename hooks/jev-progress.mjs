#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_STARTED_AT = Date.now();

const QUESTIONS = {
  phase: {
    type: "score",
    instructions:
      "How far has Claude progressed toward completing the request in `task`? Judge from `activity` (oldest first), `claude_latest_message`, and `turn_status`.",
    criteria: [
      { what: "Not started. No activity yet, or only reading the request and loading instructions.", examples: ["only skill or instruction loads so far", "one directory listing"] },
      { what: "Investigating. Reading files, searching, fetching docs, or running diagnostics to understand the problem. Nothing has been changed or produced yet.", examples: ["grep and cat across several files", "curl of documentation pages", "running a failing test to see the error"] },
      { what: "Building. Writing or editing files, or producing the deliverable. Not yet checked.", examples: ["Edit or Write calls on source files", "creating a new script"] },
      { what: "Verifying. Running tests, executing the new script, or checking the result of the change.", examples: ["running the test suite after edits", "piping sample input through the new script", "build or lint after changes"] },
      { what: "Wrapping up. The change works. Only reporting, summarizing, cleanup, or committing remains.", examples: ["git commit after tests passed", "writing the final summary to the user"] },
      { what: "Done. Everything in `task` is complete and Claude has reported the outcome to the user.", examples: ["turn_status is stopped and the final message reports the finished work"] },
    ],
  },
  done: {
    type: "noul",
    instructions:
      "Has Claude finished every part of `task` and told the user the outcome? Answer yes only when `turn_status` is \"stopped\" and `claude_latest_message` reports the completed work.",
    criteria: {
      true: "`turn_status` is \"stopped\", every part of `task` was carried out, and `claude_latest_message` reports the finished result to the user.",
      false: "`turn_status` is \"working\", or some part of `task` is unfinished or unchecked, or `claude_latest_message` asks a question or promises further work instead of reporting a finished result.",
    },
  },
  waiting_on_user: {
    type: "noul",
    instructions: "Is Claude stopped and waiting for the user to answer a question, make a decision, or do something before work can continue?",
    criteria: {
      true: "`claude_latest_message` asks the user a question or asks them to do something, and work cannot continue without their reply.",
      false: "Claude is still working, or has finished, and needs nothing from the user.",
    },
  },
};

const LABELS = ["not started", "investigating", "building", "verifying", "wrapping up", "done"];
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_TASK = 3000, MAX_MESSAGE = 800, MAX_ACTIVITY = 15, MAX_SAMPLES = 20;
const TAIL_BYTES = 512 * 1024;
const TIMEOUT_MS = 8_000, LOCK_STALE_MS = 20_000, LOCK_WAIT_MS = 10_000, LOCK_POLL_MS = 200;

const str = (v) => (typeof v === "string" ? v : "");
const trunc = (s, n) => (s.length > n ? s.slice(0, n) : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remove = (p) => {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const cacheDir = () => path.join(configDir(), "cache", "jev-progress");

// Sessions launched outside a login shell (apps, launchd, SDK runs) don't inherit .zprofile.
function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try { return fs.readFileSync(path.join(configDir(), "secrets", "typesafe_api_key"), "utf8").trim(); } catch { return ""; }
}

const PRUNE_AFTER_MS = 7 * 24 * 3600_000;
function pruneOldRecords(dir, now) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try { if (now - fs.statSync(p).mtimeMs > PRUNE_AFTER_MS) remove(p); } catch {}
  }
}

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function readTail(file) {
  const size = fs.statSync(file).size;
  if (size <= TAIL_BYTES) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    const text = buf.toString("utf8");
    return text.slice(text.indexOf("\n") + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function writeRecord(file, record) {
  // Per-process temp name: UserPromptSubmit writes without the lock, so a shared `.tmp` could be interleaved and renamed corrupt.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    remove(tmp);
    throw err;
  }
}

// Re-read at write time so an error never resurrects a record that a newer prompt has already reset.
function writeFailure(file, promptId, turnStatus, message, now) {
  const current = readRecord(file);
  if (superseded(current)) return;
  writeRecord(file, { ...current, turn_status: turnStatus, last_error: trunc(String(message), 300), last_error_at: now });
}

// A reset written after this process started belongs to a newer prompt; an older record is just re-keyed.
const superseded = (current) => current.started_at > RUN_STARTED_AT;

// Live transcripts inject user entries wrapped in tags (system-reminder, local-command-stdout, task-notification, ...).
// Only a slash-command wrapper carries a real task, so every other tag-led entry is skipped rather than blocklisted.
const INJECTED = ["[SYSTEM NOTIFICATION", "Another Claude session sent a message", "<teammate-message"];
function taskFromText(raw) {
  const text = str(raw).trim();
  if (!text) return null;
  if (INJECTED.some((m) => text.startsWith(m)) || text.includes("<teammate-message")) return null;
  if (!text.startsWith("<")) return text;
  if (!text.startsWith("<command-name>")) return null;
  const match = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  return match && match[1].trim() ? match[1].trim() : null;
}

const basename = (i) => path.basename(str(i.file_path));
const DETAIL = {
  Bash: (i) => str(i.description) || "(bash command)",
  Read: basename, Edit: basename, Write: basename, MultiEdit: basename, NotebookEdit: basename,
  Grep: (i) => str(i.pattern), Glob: (i) => str(i.pattern),
  Agent: (i) => str(i.description), Skill: (i) => str(i.skill), WebFetch: (i) => str(i.url),
};

function summarize(name, input) {
  const raw = str(name);
  const tool = raw.startsWith("mcp__") ? raw.slice(raw.lastIndexOf("__") + 2) : raw;
  const i = input && typeof input === "object" ? input : {};
  const first = Object.values(i).find((v) => typeof v === "string");
  const detail = DETAIL[tool] ? DETAIL[tool](i) : first ? trunc(first, 120) : "";
  return { tool, detail };
}

function parseTranscript(file) {
  let text = "";
  try {
    text = readTail(file);
  } catch {
    return { task: null, tools: [], latest: "" };
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.isSidechain !== true) entries.push(entry);
    } catch {}
  }
  let task = null;
  for (let i = entries.length - 1; i >= 0 && task === null; i--) {
    const entry = entries[i];
    if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) continue;
    const content = entry.message?.content;
    if (typeof content === "string") task = taskFromText(content);
    else if (Array.isArray(content) && content[0]?.type === "text") task = taskFromText(content[0].text);
  }
  let latest = "";
  for (let i = entries.length - 1; i >= 0 && !latest; i--) {
    const entry = entries[i];
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    latest = entry.message.content
      .filter((b) => b?.type === "text")
      .map((b) => str(b.text))
      .join("\n")
      .trim();
  }
  const tools = [];
  for (const entry of entries) {
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type === "tool_use") tools.push({ id: str(block.id), ...summarize(block.name, block.input) });
    }
  }
  return { task, tools, latest };
}

async function evaluate(state, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions: QUESTIONS }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${trunc((await res.text()).trim(), 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Held only across the fetch. No fetch outlives its 8s timeout, so anything older than LOCK_STALE_MS was orphaned.
async function acquireLock(lock, wait) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let i = 0; i < 80; i++) {
    try {
      fs.mkdirSync(lock);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") return false;
    }
    let age = Infinity;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
    if (age > LOCK_STALE_MS) { remove(lock); continue; }
    if (!wait) return false;
    if (Date.now() >= deadline) break;
    await sleep(LOCK_POLL_MS);
  }
  return false;
}

function applyAnswers(record, existing, json, now) {
  const answers = json?.answers || {};
  const phase = answers.phase;
  if (!phase || typeof phase.score !== "number") throw new Error("no phase answer in response");
  let top = 0;
  let best = -Infinity;
  for (const [level, p] of Object.entries(phase.probabilities || {})) {
    if (typeof p === "number" && p > best) { best = p; top = Number(level); }
  }
  const progress = phase.score / (QUESTIONS.phase.criteria.length - 1);
  record.evaluated_at = now;
  record.progress = progress;
  record.phase = { score: phase.score, confidence: phase.confidence ?? 0, top_level: top, label: LABELS[top] ?? "" };
  record.done = answers.done?.noul ?? null;
  record.waiting_on_user = answers.waiting_on_user?.noul ?? null;
  record.samples = [...(Array.isArray(existing.samples) ? existing.samples : []), { t: now, progress }].slice(-MAX_SAMPLES);
  record.model = str(json.model);
  record.input_tokens = json.usage?.input_tokens ?? null;
  delete record.last_error;
  delete record.last_error_at;
}

function onPrompt(payload, file) {
  const task = taskFromText(payload.prompt);
  if (!task) return;
  writeRecord(file, {
    session_id: str(payload.session_id),
    prompt_id: str(payload.prompt_id),
    started_at: Date.now(),
    task: trunc(task, MAX_TASK),
    turn_status: "working",
    samples: [],
  });
}

async function onActivity(payload, file, lock) {
  const now = Date.now();
  const stopped = payload.hook_event_name === "Stop";
  const turnStatus = stopped ? "stopped" : "working";
  const promptId = str(payload.prompt_id);
  const key = apiKey();
  if (!key) return writeFailure(file, promptId, turnStatus, "TYPESAFE_API_KEY not set", now);
  const previous = readRecord(file);
  const parsed = parseTranscript(str(payload.transcript_path));
  const tools = parsed.tools;
  if (payload.tool_use_id && !tools.some((t) => t.id === payload.tool_use_id)) {
    tools.push(summarize(payload.tool_name, payload.tool_input));
  }
  const cached = previous.prompt_id === promptId ? str(previous.task) : "";
  const state = {
    task: trunc(cached || parsed.task || str(previous.task), MAX_TASK),
    activity: tools.slice(-MAX_ACTIVITY).map(({ tool, detail }) => ({ tool, detail })),
    claude_latest_message: trunc(stopped ? str(payload.last_assistant_message) : parsed.latest, MAX_MESSAGE),
    turn_status: turnStatus,
  };
  if (!(await acquireLock(lock, stopped))) return;
  let json;
  try {
    json = await evaluate(state, key);
  } catch (err) {
    return writeFailure(file, promptId, turnStatus, err?.message || err, now);
  } finally {
    remove(lock);
  }
  const current = readRecord(file);
  if (superseded(current)) return;
  const record = {
    ...current,
    session_id: str(payload.session_id),
    prompt_id: promptId,
    started_at: current.prompt_id === promptId && current.started_at ? current.started_at : now,
    task: state.task,
    turn_status: state.turn_status,
  };
  try {
    applyAnswers(record, current, json, now);
  } catch (err) {
    return writeFailure(file, promptId, turnStatus, err?.message || err, now);
  }
  writeRecord(file, record);
}

async function main() {
  const payload = JSON.parse(await readStdin());
  if (payload.agent_id) return;
  const event = payload.hook_event_name;
  if (event !== "UserPromptSubmit" && event !== "PostToolUse" && event !== "Stop") return;
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const sid = str(payload.session_id) || "unknown";
  const file = path.join(dir, `${sid}.json`);
  if (event === "UserPromptSubmit") {
    pruneOldRecords(dir, Date.now());
    return onPrompt(payload, file);
  }
  return onActivity(payload, file, path.join(dir, `${sid}.lock`));
}

try {
  await main();
} catch {}
process.exit(0);
