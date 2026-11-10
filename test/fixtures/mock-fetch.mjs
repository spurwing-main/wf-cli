// Preloaded with `node --import` by test/write-commands.test.mjs. Replaces
// fetch for the whole `wf` process so no request can reach Webflow: every
// request is appended to WF_TEST_FETCH_LOG and answered from the canned
// responses below.
import { appendFileSync } from "node:fs";

const log = process.env.WF_TEST_FETCH_LOG;
if (!log) throw new Error("mock-fetch: WF_TEST_FETCH_LOG is not set");

globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || "GET").toUpperCase();
  const { pathname } = new URL(String(url));
  appendFileSync(log, `${JSON.stringify({ method, path: pathname, body: init.body ? JSON.parse(init.body) : null })}\n`);
  let data = {};
  if (method === "GET" && /^\/v2\/collections\/[^/]+$/.test(pathname)) data = { fields: [{ slug: "name" }, { slug: "slug" }, { slug: "count" }] };
  if (method === "GET" && /^\/v2\/sites\/[^/]+$/.test(pathname)) data = { id: pathname.split("/").at(-1), shortName: "example", customDomains: [] };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
