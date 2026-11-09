// Shared by the hook tests: a TypeSafe stand-in on 127.0.0.1, a temp config dir, and a way
// to run the hook against both with a clean env. fetch-to-stub.mjs keeps every request on
// the stub, so no test can reach TypeSafe. JEV_HOOK=<path> runs another copy of the hook.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = process.env.JEV_HOOK || fileURLToPath(new URL("../hooks/jev-progress.mjs", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./fetch-to-stub.mjs", import.meta.url));

export const GOOD_ANSWER = {
  answers: {
    phase: { score: 2.5, confidence: 0.8, probabilities: { 2: 0.6, 3: 0.4 } },
    done: { noul: 0.1 },
    waiting_on_user: { noul: 0.2 },
  },
  model: "jev-test",
  usage: { input_tokens: 42 },
};

/** `stub.respond` decides each reply and may return a promise, to hold one open. */
export async function startStub() {
  const stub = { requests: [], respond: () => ({ body: GOOD_ANSWER }) };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      stub.requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const { status = 200, body } = await stub.respond();
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${server.address().port}/`;
  stub.close = () => new Promise((resolve) => server.close(resolve));
  return stub;
}

/** A temp CLAUDE_CONFIG_DIR plus helpers for the files the hook reads and writes. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "jev-hook-test-"));
  const config = join(dir, "config");
  const cache = join(config, "cache", "jev-progress");
  mkdirSync(cache, { recursive: true });
  return {
    dir,
    config,
    cache,
    readRecord: (sid) => JSON.parse(readFileSync(join(cache, `${sid}.json`), "utf8")),
    writeRecord: (sid, record) => writeFileSync(join(cache, `${sid}.json`), JSON.stringify(record)),
    transcript(name, lines) {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, `${lines.join("\n")}\n`);
      return file;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Runs the hook once. `env` adds to or, with undefined, removes from the clean env. */
export function runHook(payload, { stub, box, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, HOOK], {
      // Never process.env, so a real TYPESAFE_API_KEY or ~/.claude can't leak in.
      env: {
        PATH: process.env.PATH,
        HOME: join(box.dir, "home"),
        CLAUDE_CONFIG_DIR: box.config,
        TYPESAFE_API_KEY: "test-key",
        JEV_TEST_STUB: stub.url,
        ...env,
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
export const userText = (text, extra = {}) => line({ type: "user", message: { role: "user", content: text }, ...extra });
export const assistant = (content, extra = {}) =>
  line({ type: "assistant", message: { role: "assistant", content }, ...extra });
export const text = (t) => ({ type: "text", text: t });
export const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
