"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMessages, coerceResult } = require("../lib/clock");

test("prompt guards against second-hand and swapped-hand misreads", function () {
  const { PROMPT } = require("../lib/clock");
  assert.match(PROMPT, /second hand/i);
  assert.match(PROMPT, /SHORTER/i);
  assert.match(PROMPT, /hour_pos/i);
});

test("toDigital converts analog readings", function () {
  const { toDigital } = require("../lib/clock");
  assert.deepEqual(toDigital("11:42 AM"), { twelve: "11:42 AM", twentyFour: "11:42" });
  assert.deepEqual(toDigital("3:42 PM"), { twelve: "3:42 PM", twentyFour: "15:42" });
  assert.deepEqual(toDigital("12:00 AM"), { twelve: "12:00 AM", twentyFour: "00:00" });
  assert.deepEqual(toDigital("12:26 PM"), { twelve: "12:26 PM", twentyFour: "12:26" });
  assert.deepEqual(toDigital("11:15"), { twelve: "11:15", twentyFour: "11:15" });
  assert.equal(toDigital("not a clock"), null);
  assert.equal(toDigital(null), null);
});

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
    hour: 3,
    minute: 42,
    time: "3:42 PM",
    quip: "Wow, a clock. Groundbreaking.",
  });
  assert.equal(out.is_clock, true);
  assert.equal(out.time, "3:42 PM");
  assert.match(out.quip, /Groundbreaking/);
});

test("hands beat a wrong time string (11:15 misread as 3:55)", function () {
  const out = coerceResult({
    is_clock: true,
    hour: 11,
    minute: 15,
    time: "3:55 PM",
    quip: "Close enough.",
  });
  assert.equal(out.is_clock, true);
  assert.equal(out.time, "11:15 PM");
});

test("hands compose a time when the string is missing", function () {
  const out = coerceResult({ is_clock: true, hour: 11, minute: 15, quip: "x" });
  assert.equal(out.is_clock, true);
  assert.equal(out.time, "11:15");
});

test("out-of-range hands are rejected", function () {
  assert.equal(coerceResult({ is_clock: true, hour: 14, minute: 15, time: "2:15 PM" }).is_clock, false);
  assert.equal(coerceResult({ is_clock: true, hour: 3, minute: 99, time: "3:42 PM" }).is_clock, false);
});

test("consistent hour_pos is accepted (11:26 at 11.4)", function () {
  const out = coerceResult({ is_clock: true, hour: 11, minute: 26, hour_pos: 11.4, time: "11:26 AM", quip: "x" });
  assert.equal(out.is_clock, true);
  assert.equal(out.time, "11:26 AM");
});

test("contradicting hour_pos is refused", function () {
  // hands claim 11:26 but hour hand reported near the 4: reject, keep quip
  const out = coerceResult({ is_clock: true, hour: 11, minute: 26, hour_pos: 3.9, time: "11:26 AM", quip: "My bad." });
  assert.equal(out.is_clock, false);
  assert.equal(out.time, null);
  assert.equal(out.quip, "My bad.");
});

test("hour_pos works across the 12 boundary", function () {
  // at 12:26 the hand sits just past 12, i.e. ~0.43 on the dial
  const ok = coerceResult({ is_clock: true, hour: 12, minute: 26, hour_pos: 0.43, time: "12:26 PM", quip: "x" });
  assert.equal(ok.is_clock, true);
  assert.equal(ok.time, "12:26 PM");
  const noon = coerceResult({ is_clock: true, hour: 12, minute: 0, hour_pos: 12.0, time: "12:00 PM", quip: "x" });
  assert.equal(noon.is_clock, true);
  const bad = coerceResult({ is_clock: true, hour: 12, minute: 26, hour_pos: 5.4, time: "12:26 PM", quip: "y" });
  assert.equal(bad.is_clock, false);
});

test("absent hour_pos keeps old behavior", function () {
  const out = coerceResult({ is_clock: true, hour: 3, minute: 42, time: "3:42 PM", quip: "x" });
  assert.equal(out.is_clock, true);
  assert.equal(out.time, "3:42 PM");
});

test("legacy reply without hands still accepted", function () {
  const out = coerceResult({ is_clock: true, time: "3:42 PM", quip: "x" });
  assert.equal(out.is_clock, true);
  assert.equal(out.time, "3:42 PM");
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
