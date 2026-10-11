"use strict";

/* AI Clock — Node backend.
 * Serves the static frontend and exposes POST /api/read-clock, which sends a
 * clock photo (upload or live-camera snapshot) to a vision model through any
 * OpenAI-compatible chat-completions endpoint and returns structured JSON.
 * Requires Node >= 18 (global fetch) and an API key.
 */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const multer = require("multer");
const path = require("path");
const { buildMessages, coerceResult, toDigital } = require("./lib/clock");
const { computeAccuracy, computeStats, faceGapSec, formatExpected, sourceOf } = require("./lib/stats");

// MongoDB (optional): per-request read records for the Statistics tab.
// Without MONGO_URI, reads still work; /api/stats reports unconfigured.
const READS_COLLECTION = "model_usage";
let mongoDb = null;
async function getDb() {
  if (mongoDb) return mongoDb;
  if (!process.env.MONGO_URI) return null;
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  mongoDb = client.db();
  console.log("mongo connected for ai-clock stats");
  return mongoDb;
}

function saveRead(doc) {
  getDb()
    .then(function (db) {
      if (!db) return null;
      return db.collection(READS_COLLECTION).insertOne(doc);
    })
    .catch(function () {
      // stats are best-effort; never break a read
    });
}

const CAPTURE_DIR = path.join(__dirname, "captures");

// Frame captures are a local accuracy-debugging aid. Off by default;
// set SAVE_CAPTURES=1 to write Ask frames to captures/ for debugging.
function capturesEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.SAVE_CAPTURES || ""));
}

// Persist one Ask frame for accuracy debugging. Returns the saved filename.
function saveCapture(buffer, ext) {
  try {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  } catch (e) {
    // captures are best-effort debug aid; reads still work without them
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 17);
  const name = "capture-" + stamp + "-" + process.pid + "." + ext;
  fs.writeFileSync(path.join(CAPTURE_DIR, name), buffer);
  return name;
}

function stampTimeOnCapture(name, time, model) {
  if (!time) return name;
  const tag = String(time).replace(/[^A-Za-z0-9]+/g, "");
  const ext = path.extname(name);
  let renamed = path.basename(name, ext) + "--read-" + tag;
  if (model) renamed += "--" + String(model).replace(/[^A-Za-z0-9]+/g, "");
  renamed += ext;
  try {
    fs.renameSync(path.join(CAPTURE_DIR, name), path.join(CAPTURE_DIR, renamed));
    return renamed;
  } catch (e) {
    return name;
  }
}

const PORT = parseInt(process.env.PORT || "8001", 10);
// Model providers. One consistent triple per provider in .env:
//   <NAME>_BASE_URL, <NAME>_MODEL, <NAME>_API_KEY
// (spark also honors the legacy LLM_* names as fallback). The page dropdown
// posts {model: "spark"|"gemma"|"gemini"}; anything else falls back to spark.
function selectModel(name) {
  if (name === "gemma") {
    return {
      name: "gemma",
      baseUrl: process.env.GEMMA_BASE_URL || "https://ollama.com/v1/chat/completions",
      apiKey: process.env.GEMMA_API_KEY || "",
      model: process.env.GEMMA_MODEL || "gemma4:31b",
      keyVar: "GEMMA_API_KEY",
    };
  }
  if (name === "gemini") {
    return {
      name: "gemini",
      baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: process.env.GEMINI_API_KEY || "",
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      keyVar: "GEMINI_API_KEY",
    };
  }
  return {
    name: "spark",
    baseUrl:
      process.env.SPARK_BASE_URL ||
      process.env.LLM_BASE_URL ||
      "https://api.meta.ai/v1/chat/completions",
    apiKey: process.env.SPARK_API_KEY || process.env.LLM_API_KEY || "",
    model: process.env.SPARK_MODEL || process.env.LLM_MODEL || "muse-spark-1.3",
    keyVar: "SPARK_API_KEY",
  };
}
// Ring path: frame grabs go through the local go2rtc gateway (same machine
// or reachable over LAN/VPN). Never exposed to the browser.
const GO2RTC_URL = (process.env.GO2RTC_URL || "http://localhost:1984").replace(/\/+$/, "");
const RING_SRC = process.env.RING_SRC || "clockcam";

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function fetchRingFrameOnce() {
  let r;
  try {
    r = await fetch(GO2RTC_URL + "/api/frame.jpeg?src=" + encodeURIComponent(RING_SRC));
  } catch (e) {
    const err = new Error("ring gateway unreachable at " + GO2RTC_URL);
    err.status = 502;
    throw err;
  }
  if (!r.ok) {
    const err = new Error("ring gateway refused the frame (" + r.status + ")");
    err.status = 502;
    throw err;
  }
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!buffer.length) {
    const err = new Error("ring gateway returned an empty frame");
    err.status = 502;
    throw err;
  }
  return buffer;
}

// Ring snapshots flake: a first grab often 500s while a retry succeeds.
// One silent retry (1.5s apart) before surfacing the 502 to the page.
async function fetchRingFrame() {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      return await fetchRingFrameOnce();
    } catch (e) {
      last = e;
      if (i === 0) await sleep(1500);
    }
  }
  throw last;
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    // Accept raw uploads AND data-URL snapshots re-encoded by the client.
    if (/^image\//.test(file.mimetype || "")) cb(null, true);
    else cb(new Error("only image uploads are accepted"));
  },
});

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: "5mb" }));

// Public player URL served to the browser. Local default; deployments set
// RING_PLAYER_URL to the public go2rtc address (Hetzner box, tunnel, …).
const RING_PLAYER_URL =
  process.env.RING_PLAYER_URL || "http://localhost:1984/stream.html?src=clockcam";

app.get("/api/config", function (req, res) {
  res.json({ ringPlayerUrl: RING_PLAYER_URL });
});

app.get("/api/health", function (req, res) {
  const models = {};
  ["spark", "gemma", "gemini"].forEach(function (name) {
    const cfg = selectModel(name);
    models[name] = { model: cfg.model, configured: cfg.apiKey.length > 0 };
  });
  res.json({ ok: true, models: models });
});

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

// Pull answer text out of a chat message. Handles plain strings, OpenAI
// content-block arrays, and nested text parts. Returns "" when the model
// answered with nothing usable (tool calls, empty content).
function extractMessageText(msg) {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map(function (p) {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        return "";
      })
      .join("");
  }
  return "";
}

// One request, one log block: separator line, pretty request, pretty
// response. Image bytes and API keys are NEVER logged — only part types,
// text lengths, and payload sizes.
function endpointHost(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return "unknown";
  }
}

function summarizeMessages(messages) {
  return (messages || []).map(function (m) {
    return {
      role: m.role,
      content: (m.content || []).map(function (p) {
        if (p.type === "text") return { type: "text", chars: (p.text || "").length };
        if (p.type === "image_url") {
          return { type: "image_url", url_chars: ((p.image_url && p.image_url.url) || "").length };
        }
        return { type: p.type || "?" };
      }),
    };
  });
}

async function readClockFromDataUrl(dataUrl, question, cfg, requestTs) {
  const started = Date.now();
  const body = {
    model: cfg.model,
    messages: buildMessages(dataUrl, question),
    temperature: 0.2,
    // Reasoning models spend tokens thinking (Spark has burned ~2000 on
    // a single clock); cap low and the answer is cut off before it starts.
    max_tokens: 8000,
  };
  console.log("\n------Starting a new request (" + cfg.name + " / " + cfg.model + ")-----");
  console.log(
    JSON.stringify(
      {
        event: "llm_request",
        model: cfg.model,
        endpoint: endpointHost(cfg.baseUrl),
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        messages: summarizeMessages(body.messages),
      },
      null,
      2
    )
  );
  // No response must hang the page forever: cap the upstream wait
  // (MODEL_TIMEOUT_MS, default 120s) so a stalled model surfaces as a
  // 502 the page can show instead of "…" until the heat death.
  const timeoutMs = parseInt(process.env.MODEL_TIMEOUT_MS || "120000", 10) || 120000;
  let resp;
  try {
    resp = await fetch(cfg.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const err = new Error(
      timedOut
        ? "vision model timed out after " + Math.round(timeoutMs / 1000) + "s with no response"
        : "vision model unreachable: " + (e.message || e)
    );
    err.status = 502;
    throw err;
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch (e) {
      detail = "";
    }
    console.log(JSON.stringify({ event: "read_clock_error", status: resp.status, detail: detail }));
    const err = new Error("vision model error " + resp.status + (detail ? ": " + detail : ""));
    err.status = 502;
    throw err;
  }
  const data = await resp.json();
  const firstChoice = data && data.choices && data.choices[0] ? data.choices[0] : null;
  const firstMsg =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message
      : null;
  const text = extractMessageText(firstMsg);
  console.log(
    JSON.stringify(
      {
        event: "llm_response",
        model: cfg.model,
        finish_reason: firstChoice ? firstChoice.finish_reason || null : null,
        usage: data && data.usage ? data.usage : null,
        refusal: firstMsg && firstMsg.refusal != null ? String(firstMsg.refusal).slice(0, 500) : null,
        response: String(text).slice(0, 2000),
      },
      null,
      2
    )
  );
  let raw = null;
  try {
    raw = JSON.parse(String(text).trim());
  } catch (e) {
    raw = null;
  }
  const responseTs = Date.now();
  const usage = data && data.usage ? data.usage : null;
  console.log(
    JSON.stringify({
      event: "read_clock",
      model: cfg.model,
      latency_ms: responseTs - started,
      raw: String(text).slice(0, 500),
    })
  );
  return {
    reading: coerceResult(raw),
    parsed: raw !== null,
    usage: usage,
    requestTs: typeof requestTs === "number" ? requestTs : started,
    responseTs: responseTs,
  };
}

// Scoring moment: prefer the client's wall clock when it arrives intact —
// the server may run in another timezone (e.g. UTC on Render) than the
// clock being read, and an epoch alone cannot recover wall-clock fields:
// getHours() on the server would just re-render the server's own zone.
// score is { now: epoch ms, tzOffset: getTimezoneOffset() minutes }.
// Anything malformed falls back to the server request moment. The returned
// Date is shifted so the server's own getHours()/getMinutes() read out the
// CLIENT's wall fields; stored request/response timestamps stay server-side.
function scoringDate(out, score) {
  const ok = score && typeof score.now === "number" && isFinite(score.now) &&
    score.now >= 1e12 && score.now < 1e13 &&
    typeof score.tzOffset === "number" && isFinite(score.tzOffset) &&
    score.tzOffset >= -840 && score.tzOffset <= 720;
  if (ok) {
    const serverOffset = new Date(score.now).getTimezoneOffset();
    return new Date(score.now + (serverOffset - score.tzOffset) * 60000);
  }
  return out && typeof out.requestTs === "number" ? new Date(out.requestTs) : null;
}

// One stat record per model attempt. success = the model answered with
// parseable JSON (including "not a clock"); accuracy is scored only when
// success produced a time, comparing it against the scoring moment above.
// Stored request/response timestamps always stay server-side (latency).
function statDoc(cfg, question, result, out, success, error, source, score) {
  const usage = (out && out.usage) || {};
  const requestDate = scoringDate(out, score);
  const accuracy =
    success && result && result.time && requestDate
      ? computeAccuracy(result.time, requestDate)
      : null;
  return {
    model: cfg.name,
    modelId: cfg.model,
    // "ring" | "synthetic" | "upload". Docs saved before sources existed
    // were all ring reads, so missing means ring.
    source: source === "synthetic" || source === "upload" ? source : "ring",
    question: question || "",
    reading: result && result.time ? result.time : null,
    error: typeof error === "string" && error ? error.slice(0, 300) : null,
    expected_response: requestDate ? formatExpected(requestDate) : null,
    off_by_sec:
      success && result && result.time && requestDate
        ? faceGapSec(result.time, requestDate)
        : null,
    accuracy: accuracy,
    success: success,
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
    requestTs: out ? out.requestTs : null,
    responseTs: out ? out.responseTs : null,
    responseMs:
      out && typeof out.requestTs === "number" && typeof out.responseTs === "number"
        ? out.responseTs - out.requestTs
        : null,
    createdAt: new Date(),
  };
}

// Phase 1: multipart upload. Phase 2 posts {image: dataUrl} JSON instead —
// same model call, so the camera snapshot path needs no new endpoint.
app.post("/api/read-clock", upload.single("image"), async function (req, res) {
  const cfg = selectModel(req.body && req.body.model);
  if (!cfg.apiKey) return bad(res, 500, cfg.keyVar + " is not configured");
  const question =
    (req.body && req.body.question ? String(req.body.question) : "").slice(0, 300);
  let dataUrl = null;
  let frame = null; // {buffer, ext} kept for the debug capture
  if (req.file && req.file.buffer) {
    dataUrl =
      "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
    frame = {
      buffer: req.file.buffer,
      ext: (req.file.mimetype.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg",
    };
  } else if (req.body && typeof req.body.image === "string") {
    if (!/^data:image\//.test(req.body.image)) {
      return bad(res, 400, "image must be a data:image/... URL");
    }
    if (req.body.image.length > 12 * 1024 * 1024) {
      return bad(res, 400, "image too large");
    }
    dataUrl = req.body.image;
    const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
    if (m) {
      frame = {
        buffer: Buffer.from(m[2], "base64"),
        ext: (m[1].split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg",
      };
    }
  } else if (req.body && req.body.ring === true) {
    // Ring fixed camera: backend pulls the latest gateway frame itself,
    // so the browser never touches stream URLs or credentials.
    let buffer;
    try {
      buffer = await fetchRingFrame();
    } catch (e) {
      return bad(res, e.status || 502, e.message || "ring frame failed");
    }
    frame = { buffer: buffer, ext: "jpg" };
    dataUrl = "data:image/jpeg;base64," + buffer.toString("base64");
  } else {
    return bad(res, 400, "send a clock photo as multipart 'image' or JSON {image}");
  }
  let capture = null;
  if (frame && capturesEnabled()) {
    try {
      capture = saveCapture(frame.buffer, frame.ext);
    } catch (e) {
      capture = null;
    }
  }
  const requestTs = Date.now();
  // Read source: explicit body field wins, legacy ring flag next,
  // anything else is an upload.
  const source =
    req.body && req.body.source === "synthetic"
      ? "synthetic"
      : req.body && req.body.ring
        ? "ring"
        : "upload";
  // Client wall clock for accuracy scoring (validated inside statDoc);
    // the server may run in another timezone than the clock being read.
  const clientClock = req.body && typeof req.body === "object"
    ? { now: req.body.clientNow, tzOffset: req.body.clientTzOffset }
    : undefined;
  try {
    const out = await readClockFromDataUrl(dataUrl, question, cfg, requestTs);
    const result = out.reading;
    saveRead(statDoc(cfg, question, result, out, out.parsed, null, source, clientClock));
    if (capture) {
      capture = stampTimeOnCapture(capture, result.time, cfg.name);
      console.log(JSON.stringify({ event: "read_clock_capture", file: capture, time: result.time, model_used: cfg.name }));
    }
    result.capture = capture;
    result.model_used = cfg.name;
    if (result.time) result.digital = toDigital(result.time);
    return res.json(result);
  } catch (e) {
    saveRead(statDoc(cfg, question, null, { requestTs: requestTs, responseTs: Date.now(), usage: null }, false, e.message || "read failed", source));
    return bad(res, e.status || 500, e.message || "read failed");
  }
});

app.get("/api/stats", async function (req, res) {
  let db = null;
  try {
    db = await getDb();
  } catch (e) {
    db = null;
  }
  if (!db) return res.status(503).json({ error: "database not configured — set MONGO_URI and restart" });
  try {
    const col = db.collection(READS_COLLECTION);
    const totalReads = await col.countDocuments();
    const docs = await col.find({}).sort({ createdAt: -1 }).limit(10000).toArray();
    // ?source=ring|synthetic|upload filters to that source (one row per
    // model); anything else merges all sources into one row per model.
    const want = req.query && req.query.source;
    const known = want === "ring" || want === "synthetic" || want === "upload";
    const subset = known ? docs.filter(function (d) { return sourceOf(d) === want; }) : docs;
    return res.json({ rows: computeStats(subset, { mergeSources: !known }), totalReads: totalReads });
  } catch (e) {
    return bad(res, 500, "stats unavailable");
  }
});

if (require.main === module) {
  app.listen(PORT, function () {
    console.log("ai-clock on http://localhost:" + PORT);
  });
}

module.exports = app;
module.exports.fetchRingFrame = fetchRingFrame;
module.exports.extractMessageText = extractMessageText;
module.exports.selectModel = selectModel;
module.exports.READS_COLLECTION = READS_COLLECTION;
module.exports.statDoc = statDoc;
module.exports.capturesEnabled = capturesEnabled;
module.exports.stampTimeOnCapture = stampTimeOnCapture;
module.exports.readClockFromDataUrl = readClockFromDataUrl;
