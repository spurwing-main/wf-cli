import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The commands that write client data, run end to end through bin/wf.mjs with
// fetch replaced by test/fixtures/mock-fetch.mjs. Nothing here can reach the
// Webflow API: the mock answers every request and logs it, so each test can
// assert both what was refused before any request and the exact body sent.

const BIN = fileURLToPath(new URL("../bin/wf.mjs", import.meta.url));
const MOCK = new URL("./fixtures/mock-fetch.mjs", import.meta.url).href;

let dir;
let fetchLog;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-write-commands-"));
  fetchLog = join(dir, "fetch.jsonl");
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const grants = await import("../lib/grants.mjs");
const profiles = await import("../lib/profiles.mjs");

const PROFILE = "acme";
const SITE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const COLLECTION = "cccccccccccccccccccccccc";
const ITEM = "iiiiiiiiiiiiiiiiiiiiiiii";
const ITEM_B = "jjjjjjjjjjjjjjjjjjjjjjjj";

const grant = (tier) => grants.issueGrant({ profile: PROFILE, tier, ttlMs: 60_000, siteIds: [SITE] });

const wf = (...args) => {
  const res = spawnSync(process.execPath, ["--import", MOCK, BIN, ...args, "--profile", PROFILE], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, WF_TEST_FETCH_LOG: fetchLog }
  });
  const sent = existsSync(fetchLog)
    ? readFileSync(fetchLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { status: res.status, output: `${res.stdout}${res.stderr}`, sent };
};

beforeEach(() => {
  rmSync(fetchLog, { force: true });
  grants.revokeAll();
  profiles.setToken(PROFILE, "tok_test_only_not_real_000", { preferFile: true });
  profiles.cacheCollections(PROFILE, SITE, [{ id: COLLECTION }]);
});

describe("wf items set", () => {
  it("sends the --set values inside fieldData, after checking the slugs", () => {
    grant("write");
    const res = wf("items", "set", COLLECTION, ITEM, "--set", "name=Acme", "--set", "count=3", "--archived", "false");
    assert.equal(res.status, 0, res.output);
    assert.deepEqual(
      res.sent.map((r) => `${r.method} ${r.path}`),
      [`GET /v2/collections/${COLLECTION}`, `PATCH /v2/collections/${COLLECTION}/items/${ITEM}`]
    );
    assert.deepEqual(res.sent[1].body, { fieldData: { name: "Acme", count: 3 }, isArchived: false });
  });

  it("refuses an unknown slug before sending the write", () => {
    grant("write");
    const res = wf("items", "set", COLLECTION, ITEM, "--set", "nope=x");
    assert.equal(res.status, 1);
    assert.match(res.output, /Unknown field slug/);
    assert.ok(!res.sent.some((r) => r.method === "PATCH"));
  });

  it("refuses without any grant and sends nothing", () => {
    const res = wf("items", "set", COLLECTION, ITEM, "--set", "name=Acme", "--no-validate");
    assert.equal(res.status, 1);
    assert.match(res.output, /WF_NO_GRANT/);
    assert.deepEqual(res.sent, []);
  });
});

describe("wf items set --live", () => {
  it("refuses without --confirm <itemId>, before any request", () => {
    grant("danger");
    for (const extra of [[], ["--confirm", ITEM_B]]) {
      const res = wf("items", "set", COLLECTION, ITEM, "--set", "name=Acme", "--live", ...extra);
      assert.equal(res.status, 1);
      assert.match(res.output, /--live requires restating the item id/);
      assert.deepEqual(res.sent, []);
    }
  });

  it("refuses under a write grant: a live item write is danger tier", () => {
    grant("write");
    const res = wf("items", "set", COLLECTION, ITEM, "--set", "name=Acme", "--live", "--confirm", ITEM, "--no-validate");
    assert.equal(res.status, 1);
    assert.match(res.output, /WF_GRANT_TIER/);
    assert.deepEqual(res.sent, []);
  });

  it("sends the PATCH to the live item under a danger grant with the right --confirm", () => {
    grant("danger");
    const res = wf("items", "set", COLLECTION, ITEM, "--set", "name=Acme", "--live", "--confirm", ITEM, "--no-validate");
    assert.equal(res.status, 0, res.output);
    assert.deepEqual(res.sent, [{ method: "PATCH", path: `/v2/collections/${COLLECTION}/items/${ITEM}/live`, body: { fieldData: { name: "Acme" } } }]);
  });

  it("--dry names danger tier and the item id to confirm", () => {
    const res = wf("items", "set", COLLECTION, ITEM, "--set", "name=Acme", "--live", "--confirm", ITEM, "--dry");
    assert.equal(res.status, 0, res.output);
    assert.match(res.output, /"tierNeeded": "danger"/);
    assert.match(res.output, new RegExp(`"confirmRequired": "--confirm ${ITEM}"`));
    assert.deepEqual(res.sent, []);
  });
});

describe("wf call items create-item", () => {
  it("sends the --data body as given under a write grant", () => {
    grant("write");
    const body = { fieldData: { name: "New", slug: "new" } };
    const res = wf("call", "items", "create-item", "--p", `collection_id=${COLLECTION}`, "--data", JSON.stringify(body));
    assert.equal(res.status, 0, res.output);
    assert.deepEqual(res.sent, [{ method: "POST", path: `/v2/collections/${COLLECTION}/items`, body }]);
  });

  it("refuses a slug at the top level instead of inside fieldData, before any request", () => {
    grant("write");
    const res = wf("call", "items", "create-item", "--p", `collection_id=${COLLECTION}`, "--data", '{"name":"New"}');
    assert.equal(res.status, 1);
    assert.deepEqual(res.sent, []);
  });
});

describe("wf item publish", () => {
  it("refuses without --confirm, or with only part of the id set", () => {
    grant("danger");
    for (const extra of [[], ["--confirm", ITEM]]) {
      const res = wf("item", "publish", COLLECTION, ITEM_B, ITEM, ...extra);
      assert.equal(res.status, 1);
      assert.match(res.output, /WF_CONFIRM_REQUIRED/);
      assert.deepEqual(res.sent, []);
    }
  });

  it("refuses under a write grant", () => {
    grant("write");
    const res = wf("item", "publish", COLLECTION, ITEM, "--confirm", ITEM);
    assert.equal(res.status, 1);
    assert.match(res.output, /WF_GRANT_TIER/);
    assert.deepEqual(res.sent, []);
  });

  it("sends {itemIds} under a danger grant with the sorted set confirmed", () => {
    grant("danger");
    const res = wf("item", "publish", COLLECTION, ITEM_B, ITEM, "--confirm", `${ITEM},${ITEM_B}`);
    assert.equal(res.status, 0, res.output);
    assert.deepEqual(res.sent, [{ method: "POST", path: `/v2/collections/${COLLECTION}/items/publish`, body: { itemIds: [ITEM_B, ITEM] } }]);
  });
});

describe("wf publish (site)", () => {
  it("reads the site but refuses the publish without --confirm <siteId>", () => {
    grant("danger");
    const res = wf("publish", SITE);
    assert.equal(res.status, 1);
    assert.match(res.output, /WF_CONFIRM_REQUIRED/);
    assert.deepEqual(
      res.sent.map((r) => r.method),
      ["GET"]
    );
  });

  it("refuses under a write grant even with --confirm", () => {
    grant("write");
    const res = wf("publish", SITE, "--confirm", SITE);
    assert.equal(res.status, 1);
    assert.match(res.output, /WF_GRANT_TIER/);
    assert.ok(!res.sent.some((r) => r.method === "POST"));
  });
});

describe("wf delete (raw)", () => {
  const path = `collections/${COLLECTION}/items/${ITEM}`;

  it("refuses without --confirm <itemId>", () => {
    grant("danger");
    const res = wf("delete", path);
    assert.equal(res.status, 1);
    assert.match(res.output, /WF_CONFIRM_REQUIRED/);
    assert.deepEqual(res.sent, []);
  });

  it("refuses under a write grant", () => {
    grant("write");
    const res = wf("delete", path, "--confirm", ITEM);
    assert.equal(res.status, 1);
    assert.match(res.output, /WF_GRANT_TIER/);
    assert.deepEqual(res.sent, []);
  });

  it("deleting one live item confirms the item id, not the word live", () => {
    grant("danger");
    const live = wf("delete", `${path}/live`, "--confirm", "live");
    assert.equal(live.status, 1);
    assert.match(live.output, new RegExp(`--confirm ${ITEM}`));
    assert.deepEqual(live.sent, []);
  });
});
