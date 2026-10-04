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
const { buildMessages, coerceResult } = require("./lib/clock");

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
const LLM_BASE_URL =
  process.env.LLM_BASE_URL || "https://api.llama.com/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "Llama-4-Maverick-17B-128E-Instruct-FP8";

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

app.get("/api/health", function (req, res) {
  res.json({ ok: true, model: LLM_MODEL, configured: LLM_API_KEY.length > 0 });
});

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

async function readClockFromDataUrl(dataUrl, question) {
  const started = Date.now();
  const body = {
    model: LLM_MODEL,
    messages: buildMessages(dataUrl, question),
    temperature: 0.2,
    max_tokens: 300,
  };
  let resp;
  try {
    resp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LLM_API_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error("vision model unreachable: " + (e.message || e));
    err.status = 502;
    throw err;
  }
  if (!resp.ok) {
    const err = new Error("vision model error " + resp.status);
    err.status = 502;
    throw err;
  }
  const data = await resp.json();
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  let raw = null;
  try {
    raw = JSON.parse(String(text).trim());
  } catch (e) {
    raw = null;
  }
  console.log(
    JSON.stringify({
      event: "read_clock",
      model: LLM_MODEL,
      latency_ms: Date.now() - started,
      raw: String(text).slice(0, 500),
    })
  );
  return coerceResult(raw);
}

// Phase 1: multipart upload. Phase 2 posts {image: dataUrl} JSON instead —
// same model call, so the camera snapshot path needs no new endpoint.
app.post("/api/read-clock", upload.single("image"), async function (req, res) {
  if (!LLM_API_KEY) return bad(res, 500, "LLM_API_KEY is not configured");
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
  try {
    const result = await readClockFromDataUrl(dataUrl, question);
    if (capture) {
      capture = stampTimeOnCapture(capture, result.time);
      console.log(JSON.stringify({ event: "read_clock_capture", file: capture, time: result.time }));
    }
    result.capture = capture;
    return res.json(result);
  } catch (e) {
    return bad(res, e.status || 500, e.message || "read failed");
  }
});

if (require.main === module) {
  app.listen(PORT, function () {
    console.log("ai-clock on http://localhost:" + PORT);
  });
}

module.exports = app;
