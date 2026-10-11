"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClockMinutes, computeAccuracy, computeStats, faceGapSec, formatExpected } = require("../lib/stats");

function at(h, m, s) {
  return new Date(2026, 9, 4, h, m, s || 0);
}

test("accuracy tolerance is ±150 seconds", function () {
  const { ACCURACY_TOLERANCE_SEC } = require("../lib/stats");
  assert.equal(ACCURACY_TOLERANCE_SEC, 150);
});

test("accuracy passes within tolerance", function () {
  assert.equal(computeAccuracy("3:20 PM", at(15, 20, 30)), true);
  assert.equal(computeAccuracy("3:20 PM", at(15, 19, 20)), true);
  assert.equal(computeAccuracy("3:20 PM", at(15, 21, 0)), true);
  assert.equal(computeAccuracy("3:20 PM", at(15, 22, 5)), true);
  assert.equal(computeAccuracy("3:20 PM", at(15, 22, 30)), true);
});

test("accuracy fails beyond tolerance", function () {
  assert.equal(computeAccuracy("3:20 PM", at(15, 23, 0)), false);
  assert.equal(computeAccuracy("11:42 AM", at(15, 20, 0)), false);
});

test("accuracy wraps midnight both ways", function () {
  assert.equal(computeAccuracy("12:00 AM", at(23, 59, 30)), true);
  assert.equal(computeAccuracy("11:59 PM", at(0, 0, 0)), true);
});

test("bare time without suffix tries both halves", function () {
  assert.equal(computeAccuracy("11:15", at(11, 15, 30)), true);
  assert.equal(computeAccuracy("11:15", at(23, 15, 30)), true);
  assert.equal(computeAccuracy("11:15", at(15, 20, 0)), false);
});

test("AM/PM is ignored in accuracy", function () {
  assert.equal(computeAccuracy("3:20 PM", at(3, 20, 30)), true);
  assert.equal(computeAccuracy("3:20 AM", at(15, 20, 30)), true);
  assert.equal(computeAccuracy("12:00 AM", at(12, 0, 30)), true);
  assert.equal(computeAccuracy("11:42 AM", at(15, 20, 0)), false);
});

test("face gap measures seconds off, expected formats the request", function () {
  assert.equal(faceGapSec("3:20 PM", at(15, 20, 30)), 30);
  assert.equal(faceGapSec("3:20 PM", at(15, 23, 0)), 180);
  assert.equal(faceGapSec("12:00 AM", at(23, 59, 30)), 30);
  assert.equal(faceGapSec(null, at(15, 20)), null);
  assert.equal(formatExpected(at(15, 20, 45)), "3:20 PM");
  assert.equal(formatExpected(at(0, 5, 0)), "12:05 AM");
  assert.equal(formatExpected(at(12, 0, 0)), "12:00 PM");
});

test("unscorable inputs give null", function () {
  assert.equal(computeAccuracy(null, at(15, 20)), null);
  assert.equal(computeAccuracy("3:20 PM", null), null);
  assert.equal(parseClockMinutes("garbage"), null);
});

test("computeStats aggregates one row per model", function () {
  const rows = [
    { model: "spark", accuracy: true, promptTokens: 3000, completionTokens: 2000, requestTs: 1000, responseTs: 6000 },
    { model: "spark", accuracy: false, promptTokens: 3100, completionTokens: 2100, requestTs: 2000, responseTs: 12000 },
    { model: "spark", accuracy: null, promptTokens: 100, completionTokens: 10, requestTs: 3000, responseTs: 4000 },
    { model: "gemma", accuracy: true, promptTokens: 500, completionTokens: 50, requestTs: 4000, responseTs: 5000 },
  ];
  const out = computeStats(rows);
  assert.equal(out.length, 2);
  const spark = out.filter(function (r) { return r.model === "spark"; })[0];
  assert.equal(spark.reads, 3);
  assert.equal(spark.accuracyPct, 50);
  assert.equal(spark.meanPromptTokens, 2066.7);
  assert.equal(spark.meanCompletionTokens, 1370);
  assert.equal(spark.p90ResponseMs, 10000);
  const gemma = out.filter(function (r) { return r.model === "gemma"; })[0];
  assert.equal(gemma.accuracyPct, 100);
  assert.equal(gemma.p90ResponseMs, 1000);
});

test("computeStats splits one row per model per source", function () {
  const rows = [
    { model: "spark", source: "ring", accuracy: true },
    { model: "spark", source: "ring", accuracy: false },
    { model: "spark", source: "synthetic", accuracy: true },
    { model: "spark", accuracy: true },
  ];
  const out = computeStats(rows);
  assert.equal(out.length, 2);
  const ring = out.filter(function (r) { return r.source === "ring"; })[0];
  const synth = out.filter(function (r) { return r.source === "synthetic"; })[0];
  assert.equal(ring.model, "spark");
  assert.equal(ring.reads, 3);
  assert.equal(ring.accuracyPct, 66.7);
  assert.equal(synth.reads, 1);
  assert.equal(synth.accuracyPct, 100);
});

test("computeStats merges sources into one row per model", function () {
  const { computeStats } = require("../lib/stats");
  const rows = [
    { model: "spark", source: "ring", accuracy: true, promptTokens: 3000, completionTokens: 2000, requestTs: 1000, responseTs: 6000 },
    { model: "spark", source: "synthetic", accuracy: false, promptTokens: 1000, completionTokens: 1000, requestTs: 2000, responseTs: 4000 },
  ];
  const out = computeStats(rows, { mergeSources: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].model, "spark");
  assert.equal(out[0].source, "all");
  assert.equal(out[0].reads, 2);
  assert.equal(out[0].accuracyPct, 50);
  assert.equal(out[0].meanPromptTokens, 2000);
  assert.equal(out[0].p90ResponseMs, 5000);
});

test("statDoc stores the source and defaults to ring", function () {
  const server = require("../server.js");
  const cfg = { name: "spark", model: "muse-spark-1.3" };
  assert.equal(
    server.statDoc(cfg, "q", { time: "3:20 PM" }, { requestTs: 1, responseTs: 2, usage: null }, true, null, "synthetic").source,
    "synthetic"
  );
  assert.equal(
    server.statDoc(cfg, "q", { time: "3:20 PM" }, { requestTs: 1, responseTs: 2, usage: null }, true).source,
    "ring"
  );
});

test("read records live in the model_usage collection", function () {
  const server = require("../server.js");
  assert.equal(server.READS_COLLECTION, "model_usage");
});

test("statDoc records the error reason on failure", function () {
  const server = require("../server.js");
  const cfg = { name: "gemini", model: "gemini-3.8-flash" };
  const fail = server.statDoc(cfg, "q", null, { requestTs: 1000, responseTs: 2000, usage: null }, false, "vision model error 404: nope");
  assert.equal(fail.success, false);
  assert.equal(fail.error, "vision model error 404: nope");
  assert.equal(fail.accuracy, null);
  assert.equal(fail.requestTs, 1000);
  const ok = server.statDoc(cfg, "q", { time: "3:20 PM" }, { requestTs: 1000, responseTs: 2000, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, true);
  assert.equal(ok.success, true);
  assert.equal(ok.error, null);
  assert.equal(ok.promptTokens, 10);
});

test("computeStats handles empty and unscored input", function () {
  assert.deepEqual(computeStats([]), []);
  const out = computeStats([{ model: "gemma", accuracy: null }]);
  assert.equal(out[0].accuracyPct, null);
  assert.equal(out[0].meanPromptTokens, null);
  assert.equal(out[0].p90ResponseMs, null);
});
