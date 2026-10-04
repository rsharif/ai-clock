"use strict";

/* Pure helpers for the AI clock: prompt building + defensive coercion.
 * Kept free of I/O so tests can require this file directly.
 */

const PROMPT =
  "You are the world's first AI clock: brilliant, sarcastic, and tired of " +
  "being asked what time it is by people who own phones. " +
  "Look at the attached photo. First find the clock face and ignore " +
  "everything outside it. Read analog hands with care. There may be THREE " +
  "hands: completely IGNORE the thinnest hand (the second hand, often " +
  "orange or red) — it is not the hour or the minute. Of the two REMAINING " +
  "dark hands: the SHORTER, thicker one is the hour hand (a number 1-12 " +
  "— if it sits between two numbers, it is the one it just passed); the " +
  "LONGER, thinner one is the minute hand (multiply its number by 5). " +
  "Compare lengths explicitly before deciding. Never swap them. " +
  "Reply with JSON only, no markdown fences, no extra text, using exactly " +
  "these keys: " +
  '{"is_clock": boolean, "hour": number or null, "minute": number or null, ' +
  '"hour_pos": number or null, "time": string or null, "quip": string}. ' +
  'If the photo clearly shows a clock, set is_clock true, hour to 1-12, ' +
  'minute to 0-59, hour_pos to the hour hand\'s exact position as a ' +
  'decimal (e.g. 11.4 if it sits two-fifths of the way from 11 toward ' +
  '12), and time to the same reading in h:mm AM/PM format (e.g. ' +
  '"3:42 PM"). time MUST agree with hour and minute, and hour_pos MUST ' +
  'agree with minute (a :26 reading puts the hour hand ~40% past the hour). ' +
  'quip is one sarcastic sentence about being asked the time. ' +
  'If it is not a clock, set is_clock false, hour/minute/time null, and ' +
  'make quip a sarcastic complaint explaining what you see instead.';

function buildMessages(imageDataUrl, question) {
  const q = (question || "What time is it right now?").slice(0, 300);
  return [
    {
      role: "user",
      content: [
        { type: "text", text: PROMPT + " Their question: " + q },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

function capStr(v, max) {
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}

// Coerce raw model JSON into {is_clock, time, quip}. Never throws.
// hour/minute ground the reading: when they are valid but disagree with
// the time string (swapped hands, flipped image...), the hands win.
function numIn(v, lo, hi) {
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) v = parseInt(v.trim(), 10);
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi
    ? v
    : null;
}

function handPresentButInvalid(rawVal, coerced) {
  return rawVal !== undefined && rawVal !== null && coerced === null;
}

function numFloat(v) {
  if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v.trim()))) {
    v = Number(v.trim());
  }
  return typeof v === "number" && isFinite(v) ? v : null;
}

// Geometric check: at M minutes past hour H, the hour hand must sit near
// (H + M/60) on the 12-hour dial. Returns true when hour_pos is present
// and contradicts (hour, minute). Tolerance is 0.3h (18 min of hand
// travel) to avoid rejecting honest near-misses.
function hourPosContradicts(hour, minute, hourPosRaw) {
  const p = numFloat(hourPosRaw);
  if (p === null || hour === null || minute === null) return false;
  if (p < 0 || p > 12) return true;
  const pos12 = ((p % 12) + 12) % 12; // 12 -> 0
  const expected = (hour % 12) + minute / 60;
  const gap = Math.abs(pos12 - expected);
  return Math.min(gap, 12 - gap) > 0.3;
}

function parseTimeStr(v) {
  const m = typeof v === "string"
    ? v.trim().match(/(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?/i)
    : null;
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 1 || h > 12 || min > 59) return null;
  return { h: h, min: min, suffix: m[3].toUpperCase() + "M" };
}

// Convert a coerced time string to digital 12h/24h forms. Never throws.
function toDigital(timeStr) {
  let p = parseTimeStr(timeStr);
  if (!p && typeof timeStr === "string") {
    const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      if (h >= 1 && h <= 12 && min <= 59) {
        const mm = String(min).padStart(2, "0");
        return {
          twelve: h + ":" + mm,
          twentyFour: String(h).padStart(2, "0") + ":" + mm,
        };
      }
    }
    return null;
  }
  if (!p) return null;
  const mm = String(p.min).padStart(2, "0");
  let h24 = p.h % 12;
  if (p.suffix === "PM") h24 += 12;
  return {
    twelve: p.h + ":" + mm + " " + p.suffix,
    twentyFour: String(h24).padStart(2, "0") + ":" + mm,
  };
}

function coerceResult(raw) {
  const out = { is_clock: false, time: null, quip: "I looked, I saw nothing, and frankly I am thriving." };
  if (!raw || typeof raw !== "object") return out;
  const hour = numIn(raw.hour, 1, 12);
  const minute = numIn(raw.minute, 0, 59);
  const parsed = parseTimeStr(raw.time);
  if (handPresentButInvalid(raw.hour, hour) || handPresentButInvalid(raw.minute, minute)) {
    // Model contradicted itself (e.g. hour 14 next to "2:15 PM"):
    // refuse a confident wrong answer, keep only the quip.
    const quip0 = capStr(raw.quip, 280);
    if (quip0) out.quip = quip0;
    return out;
  }
  if (raw.hour_pos !== undefined && raw.hour_pos !== null &&
      hourPosContradicts(hour, minute, raw.hour_pos)) {
    // Hour hand's reported position is geometrically impossible next to
    // the reported minute: refuse, keep only the quip.
    const quip0 = capStr(raw.quip, 280);
    if (quip0) out.quip = quip0;
    return out;
  }
  if (raw.is_clock === true && hour !== null && minute !== null) {
    out.is_clock = true;
    const mm = String(minute).padStart(2, "0");
    if (parsed && parsed.h === hour && parsed.min === minute) {
      out.time = hour + ":" + mm + " " + parsed.suffix;
    } else {
      // Hands disagree with the string (or string missing): trust hands,
      // keep the model's AM/PM when it parsed cleanly.
      out.time = hour + ":" + mm + (parsed ? " " + parsed.suffix : "");
    }
  } else if (raw.is_clock === true && parsed) {
    // Older model reply without hands: accept a clean time string as-is.
    out.is_clock = true;
    out.time = parsed.h + ":" + String(parsed.min).padStart(2, "0") + " " + parsed.suffix;
  }
  const quip = capStr(raw.quip, 280);
  if (quip) out.quip = quip;
  return out;
}

module.exports = { PROMPT, buildMessages, coerceResult, toDigital };
