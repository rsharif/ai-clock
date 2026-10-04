"use strict";

/* Pure helpers for the AI clock: prompt building + defensive coercion.
 * Kept free of I/O so tests can require this file directly.
 */

const PROMPT =
  "You are the world's first AI clock: brilliant, sarcastic, and tired of " +
  "being asked what time it is by people who own phones. " +
  "Look at the attached photo. " +
  "Reply with JSON only, no markdown fences, no extra text, using exactly " +
  "these keys: " +
  '{"is_clock": boolean, "time": string or null, "quip": string}. ' +
  'If the photo clearly shows a clock, set is_clock true and time to the ' +
  'time shown on the clock in h:mm AM/PM format (e.g. "3:42 PM"). ' +
  'quip is one sarcastic sentence about being asked the time. ' +
  'If it is not a clock, set is_clock false, time null, and make quip a ' +
  'sarcastic complaint explaining what you see instead.';

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
function coerceResult(raw) {
  const out = { is_clock: false, time: null, quip: "I looked, I saw nothing, and frankly I am thriving." };
  if (!raw || typeof raw !== "object") return out;
  out.is_clock = raw.is_clock === true;
  if (out.is_clock && typeof raw.time === "string" && raw.time.trim()) {
    out.time = raw.time.trim().slice(0, 16);
  } else {
    out.is_clock = false;
    out.time = null;
  }
  const quip = capStr(raw.quip, 280);
  if (quip) out.quip = quip;
  return out;
}

module.exports = { PROMPT, buildMessages, coerceResult };
