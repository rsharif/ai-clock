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

test("every provider URL includes the chat-completions path", function () {
  const { selectModel } = require("../server.js");
  delete process.env.GEMINI_BASE_URL;
  delete process.env.LLM_BASE_URL;
  delete process.env.GEMMA_BASE_URL;
  ["spark", "gemma", "gemini"].forEach(function (name) {
    assert.match(selectModel(name).baseUrl, /\/chat\/completions\/?$/);
  });
});
