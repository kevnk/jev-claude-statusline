import fs from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (process.env.JEV_STATE_LOG && init?.body) {
    const body = JSON.parse(init.body);
    fs.writeFileSync(process.env.JEV_STATE_LOG, JSON.stringify(body.state, null, 2));
  }
  return real(url, init);
};
