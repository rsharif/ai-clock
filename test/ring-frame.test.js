"use strict";

//Focused regression test for the Ring Ask crash: when the gateway is
//unreachable, fetchRingFrame must reject with a 502 carrying a message
//(which the route turns into clean JSON) instead of an unhandled throw
//that kills the server. Port 9 on loopback refuses everything, so this
//needs no listener and no network.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GO2RTC_URL = "http://127.0.0.1:9";
const server = require("../server.js");

test("extractMessageText handles every reply shape", async function () {
  const { extractMessageText } = server;
  assert.equal(extractMessageText({ content: '{"a":1}' }), '{"a":1}');
  assert.equal(extractMessageText({ content: [{ type: "text", text: "hi" }, { type: "x" }] }), "hi");
  assert.equal(extractMessageText({ content: ["a", "b"] }), "ab");
  assert.equal(extractMessageText({ content: null }), "");
  assert.equal(extractMessageText({}), "");
  assert.equal(extractMessageText(null), "");
});

test("gateway refusal becomes a 502, not a crash", async function () {
  await assert.rejects(server.fetchRingFrame(), function (e) {
    assert.equal(e.status, 502);
    assert.match(e.message, /unreachable/);
    return true;
  });
});
