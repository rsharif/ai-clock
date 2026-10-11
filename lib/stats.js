"use strict";

/* Pure helpers for request statistics: accuracy scoring and per-model
 * aggregation. Kept free of I/O so tests can require this file directly.
 */

// Parse "h:mm AM/PM" (suffix optional) into minutes since midnight.
// Returns null when unparseable.
function parseClockMinutes(timeStr) {
  if (typeof timeStr !== "string") return null;
  let m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?/i);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 1 || h > 12 || min > 59) return null;
    const h24 = h % 12 + (m[3].toUpperCase() === "P" ? 12 : 0);
    return { min: h24 * 60 + min, hasSuffix: true };
  }
  m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 1 || h > 12 || min > 59) return null;
    return { min: h * 60 + min, hasSuffix: false };
  }
  return null;
}

// A reading counts as accurate when within ±150 seconds of the request
// moment (circular day handling for midnight wrap).
const ACCURACY_TOLERANCE_SEC = 150;

// Circular gap in seconds between a model reading and a request moment.
// AM/PM is ignored — only the 12-hour face position counts. Returns null
// when it cannot be scored (no reading).
function faceGapSec(modelTimeStr, requestDate) {
  const parsed = parseClockMinutes(modelTimeStr);
  if (!parsed || !(requestDate instanceof Date) || isNaN(requestDate)) return null;
  const reqSec = requestDate.getHours() * 3600 + requestDate.getMinutes() * 60 + requestDate.getSeconds();
  const faceMin = (Math.floor(parsed.min / 60) % 12) * 60 + (parsed.min % 60);
  const candidates = [faceMin * 60, faceMin * 60 + 12 * 3600];
  let best = null;
  for (const c of candidates) {
    const gap = Math.abs(c - reqSec);
    const circled = Math.min(gap, 86400 - gap);
    if (best === null || circled < best) best = circled;
  }
  return best;
}

// Accuracy: true when the face gap is within tolerance, false when scored
// but outside it, null when unscorable.
function computeAccuracy(modelTimeStr, requestDate) {
  const gap = faceGapSec(modelTimeStr, requestDate);
  if (gap === null) return null;
  return gap <= ACCURACY_TOLERANCE_SEC;
}

// The expected reading for a request moment, as "h:mm AM/PM".
function formatExpected(requestDate) {
  const h24 = requestDate.getHours();
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return h + ":" + String(requestDate.getMinutes()).padStart(2, "0") + " " + suffix;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
}

// Nearest-rank percentile over a sorted-ascending array.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

// Aggregate stored read docs into one row per model per source:
// {model, source, reads, accuracyPct, meanPromptTokens,
//  meanCompletionTokens, p90ResponseMs}. accuracyPct covers only reads
// where accuracy is known. Docs without a source predate the field and
// count as ring reads.
function sourceOf(d) {
  return d.source === "synthetic" || d.source === "upload" ? d.source : "ring";
}

function computeStats(docs, opts) {
  const merge = !!(opts && opts.mergeSources);
  const byGroup = {};
  (docs || []).forEach(function (d) {
    if (!d || !d.model) return;
    const key = merge ? d.model : d.model + "\0" + sourceOf(d);
    (byGroup[key] = byGroup[key] || []).push(d);
  });
  return Object.keys(byGroup)
    .sort()
    .map(function (key) {
      const rows = byGroup[key];
      const scored = rows.filter(function (r) { return r.accuracy === true || r.accuracy === false; });
      const hits = scored.filter(function (r) { return r.accuracy === true; }).length;
      const prompt = rows.map(function (r) { return r.promptTokens; }).filter(function (n) { return typeof n === "number"; });
      const completion = rows.map(function (r) { return r.completionTokens; }).filter(function (n) { return typeof n === "number"; });
      const lat = rows
        .map(function (r) {
          return typeof r.requestTs === "number" && typeof r.responseTs === "number"
            ? r.responseTs - r.requestTs
            : null;
        })
        .filter(function (n) { return typeof n === "number" && n >= 0; })
        .sort(function (a, b) { return a - b; });
      const model = rows[0].model;
      return {
        model: model,
        source: merge ? "all" : sourceOf(rows[0]),
        reads: rows.length,
        accuracyPct: scored.length ? Math.round((hits / scored.length) * 1000) / 10 : null,
        meanPromptTokens: mean(prompt) === null ? null : Math.round(mean(prompt) * 10) / 10,
        meanCompletionTokens: mean(completion) === null ? null : Math.round(mean(completion) * 10) / 10,
        p90ResponseMs: percentile(lat, 90),
      };
    });
}

module.exports = { parseClockMinutes, computeAccuracy, computeStats, faceGapSec, formatExpected, sourceOf, ACCURACY_TOLERANCE_SEC };
