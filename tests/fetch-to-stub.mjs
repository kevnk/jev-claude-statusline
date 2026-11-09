// Loaded with --import by tests/harness.mjs. It sends every fetch the hook makes to the
// local stub in JEV_TEST_STUB, and the hook won't start without one, so no test can reach
// TypeSafe. That holds for an old hook with no endpoint setting, too.
const stub = process.env.JEV_TEST_STUB ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(stub)) {
  throw new Error(`JEV_TEST_STUB must be http://127.0.0.1:<port>/, got "${stub}"`);
}
const realFetch = globalThis.fetch;
globalThis.fetch = (_url, init) => realFetch(stub, init);
