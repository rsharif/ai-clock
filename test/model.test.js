"use strict";

//Focused tests for provider selection behind the model dropdown.
const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server.js");
const { selectModel } = server;

test("spark is the default and the fallback", function () {
  assert.equal(selectModel("spark").name, "spark");
  assert.equal(selectModel(undefined).name, "spark");
  assert.equal(selectModel("maverick").name, "spark");
  assert.match(selectModel("spark").baseUrl, /meta\.ai/);
});

test("gemma selects the Ollama Cloud config", function () {
  const gemma = selectModel("gemma");
  assert.equal(gemma.name, "gemma");
  assert.match(gemma.baseUrl, /ollama\.com/);
  assert.equal(gemma.keyVar, "GEMMA_API_KEY");
});

test("gemini selects the Google config", function () {
  const gemini = selectModel("gemini");
  assert.equal(gemini.name, "gemini");
  assert.match(gemini.baseUrl, /generativelanguage\.googleapis\.com/);
  assert.equal(gemini.keyVar, "GEMINI_API_KEY");
});

test("spark uses the SPARK_* triple", function () {
  assert.equal(selectModel("spark").keyVar, "SPARK_API_KEY");
});

test("spark still honors legacy LLM_* names as fallback", function () {
  delete process.env.SPARK_BASE_URL;
  process.env.LLM_BASE_URL = "https://legacy.example/v1/chat/completions";
  try {
    assert.equal(selectModel("spark").baseUrl, "https://legacy.example/v1/chat/completions");
  } finally {
    delete process.env.LLM_BASE_URL;
  }
});

test("a hung model surfaces a 502 timeout instead of hanging forever", async function () {
  const realFetch = globalThis.fetch;
  const realTimeout = process.env.MODEL_TIMEOUT_MS;
  process.env.MODEL_TIMEOUT_MS = "60";
  // Faithful stand-in for fetch: never answers, but honors abort.
  globalThis.fetch = function (url, opts) {
    return new Promise(function (resolve, reject) {
      const sig = opts && opts.signal;
      function onAbort() {
        const e = new Error("This operation was aborted");
        e.name = "TimeoutError";
        reject(e);
      }
      if (!sig) return;
      if (sig.aborted) onAbort();
      else sig.addEventListener("abort", onAbort);
    });
  };
  const started = Date.now();
  try {
    await assert.rejects(
      server.readClockFromDataUrl("data:image/jpeg;base64,xx", "q", server.selectModel("gemini"), Date.now()),
      function (e) {
        assert.equal(e.status, 502);
        assert.match(e.message, /timed out after/);
        return true;
      }
    );
    assert.ok(Date.now() - started < 10000, "gave up promptly");
  } finally {
    globalThis.fetch = realFetch;
    if (realTimeout === undefined) delete process.env.MODEL_TIMEOUT_MS;
    else process.env.MODEL_TIMEOUT_MS = realTimeout;
  }
});

test("every provider URL includes the chat-completions path", function () {
  const { selectModel } = require("../server.js");
  delete process.env.GEMINI_BASE_URL;
  delete process.env.SPARK_BASE_URL;
  delete process.env.LLM_BASE_URL;
  delete process.env.GEMMA_BASE_URL;
  ["spark", "gemma", "gemini"].forEach(function (name) {
    assert.match(selectModel(name).baseUrl, /\/chat\/completions\/?$/);
  });
});
