"use strict";

// fetchRingFrame retries once before surfacing a 502: Ring snapshots often
// 500 on the first grab and succeed on the second. Stubs global fetch so no
// socket is needed.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GO2RTC_URL = "http://127.0.0.1:9";
const server = require("../server.js");

function jpegResponse() {
  return {
    ok: true,
    arrayBuffer: async function () {
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    },
  };
}

test("a first-grab 500 is retried and the frame resolves", async function () {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function () {
    calls++;
    if (calls === 1) return { ok: false, status: 500 };
    return jpegResponse();
  };
  try {
    const buf = await server.fetchRingFrame();
    assert.ok(buf.length > 0);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("two failures still surface the 502", async function () {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function () {
    calls++;
    return { ok: false, status: 500 };
  };
  try {
    await assert.rejects(server.fetchRingFrame(), function (e) {
      assert.equal(e.status, 502);
      assert.match(e.message, /refused the frame/);
      return true;
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
