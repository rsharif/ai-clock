"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMessages, coerceResult } = require("../lib/clock");

test("buildMessages wraps the frame as an image_url part", function () {
  const msgs = buildMessages("data:image/jpeg;base64,abc", "What time is it?");
  assert.equal(msgs.length, 1);
  const parts = msgs[0].content;
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/jpeg;base64,abc");
  assert.match(parts[0].text, /What time is it\?/);
});

test("coerceResult keeps a valid clock read", function () {
  const out = coerceResult({
    is_clock: true,
    time: "3:42 PM",
    quip: "Wow, a clock. Groundbreaking.",
  });
  assert.equal(out.is_clock, true);
  assert.equal(out.time, "3:42 PM");
  assert.match(out.quip, /Groundbreaking/);
});

test("coerceResult rejects non-clocks and garbage", function () {
  assert.equal(coerceResult({ is_clock: false, quip: "That is a cat." }).is_clock, false);
  assert.equal(coerceResult({ is_clock: false }).time, null);
  assert.equal(coerceResult(null).is_clock, false);
  assert.equal(coerceResult("3:42 PM").is_clock, false);
  // claims clock but no usable time -> treated as not-a-clock
  const missing = coerceResult({ is_clock: true, time: "   ", quip: "x" });
  assert.equal(missing.is_clock, false);
  assert.equal(missing.time, null);
});

test("coerceResult caps lengths and never throws", function () {
  const out = coerceResult({ is_clock: true, time: "3:42 PM", quip: "x".repeat(500) });
  assert.ok(out.quip.length <= 280);
  assert.doesNotThrow(function () {
    coerceResult({ is_clock: true, time: 42, quip: null });
  });
});
