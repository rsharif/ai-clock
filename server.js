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
const { computeAccuracy, computeStats, faceGapSec, formatExpected } = require("./lib/stats");

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
try {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
} catch (e) {
  // captures are best-effort debug aid; reads still work without them
}

// Persist one Ask frame for accuracy debugging. Returns the saved filename.
function saveCapture(buffer, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 17);
  const name = "capture-" + stamp + "-" + process.pid + "." + ext;
  fs.writeFileSync(path.join(CAPTURE_DIR, name), buffer);
  return name;
}

function stampTimeOnCapture(name, time) {
  if (!time) return name;
  const tag = String(time).replace(/[^A-Za-z0-9]+/g, "");
  const ext = path.extname(name);
  const renamed = path.basename(name, ext) + "--read-" + tag + ext;
  try {
    fs.renameSync(path.join(CAPTURE_DIR, name), path.join(CAPTURE_DIR, renamed));
    return renamed;
  } catch (e) {
    return name;
  }
}

const PORT = parseInt(process.env.PORT || "8001", 10);
// Model providers. The page dropdown posts {model: "spark"|"gemma"};
// anything else falls back to spark. Keys stay server-side in .env.
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
    baseUrl: process.env.LLM_BASE_URL || "https://api.meta.ai/v1/chat/completions",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "muse-spark-1.3",
    keyVar: "LLM_API_KEY",
  };
}
// Ring path: frame grabs go through the local go2rtc gateway (same machine
// or reachable over LAN/VPN). Never exposed to the browser.
const GO2RTC_URL = (process.env.GO2RTC_URL || "http://localhost:1984").replace(/\/+$/, "");
const RING_SRC = process.env.RING_SRC || "clockcam";

async function fetchRingFrame() {
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
  let resp;
  try {
    resp = await fetch(cfg.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error("vision model unreachable: " + (e.message || e));
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

// One stat record per model attempt. success = the model answered with
// parseable JSON (including "not a clock"); accuracy is scored only when
// success produced a time, comparing it against the request moment.
function statDoc(cfg, question, result, out, success, error) {
  const usage = (out && out.usage) || {};
  const requestDate = out && typeof out.requestTs === "number" ? new Date(out.requestTs) : null;
  const accuracy =
    success && result && result.time && requestDate
      ? computeAccuracy(result.time, requestDate)
      : null;
  return {
    model: cfg.name,
    modelId: cfg.model,
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
  if (frame) {
    try {
      capture = saveCapture(frame.buffer, frame.ext);
    } catch (e) {
      capture = null;
    }
  }
  const requestTs = Date.now();
  try {
    const out = await readClockFromDataUrl(dataUrl, question, cfg, requestTs);
    const result = out.reading;
    saveRead(statDoc(cfg, question, result, out, out.parsed));
    if (capture) {
      capture = stampTimeOnCapture(capture, result.time);
      console.log(JSON.stringify({ event: "read_clock_capture", file: capture, time: result.time, model_used: cfg.name }));
    }
    result.capture = capture;
    result.model_used = cfg.name;
    if (result.time) result.digital = toDigital(result.time);
    return res.json(result);
  } catch (e) {
    saveRead(statDoc(cfg, question, null, { requestTs: requestTs, responseTs: Date.now(), usage: null }, false, e.message || "read failed"));
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
    return res.json({ rows: computeStats(docs), totalReads: totalReads });
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
