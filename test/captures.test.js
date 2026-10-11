"use strict";

// SAVE_CAPTURES gates writing Ask frames to captures/: on by default so
// local debugging keeps working, off with 0/false/no/off (e.g. on Render).
const test = require("node:test");
const assert = require("node:assert/strict");

const { capturesEnabled } = require("../server.js");

test("captures are off by default", function () {
  delete process.env.SAVE_CAPTURES;
  assert.equal(capturesEnabled(), false);
});

test("captures turn on with 1/true/yes/on", function () {
  ["1", "true", "yes", "on", "TRUE", "On"].forEach(function (v) {
    process.env.SAVE_CAPTURES = v;
    assert.equal(capturesEnabled(), true);
  });
  delete process.env.SAVE_CAPTURES;
});

test("captures stay off with anything else", function () {
  ["0", "false", "no", "off", "banana", ""].forEach(function (v) {
    process.env.SAVE_CAPTURES = v;
    assert.equal(capturesEnabled(), false);
  });
  delete process.env.SAVE_CAPTURES;
});

const fs = require("node:fs");
const path = require("node:path");
const CAPTURE_DIR = path.join(__dirname, "..", "captures");

function makeCapture(name) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, name), "x");
  return name;
}

function scrub(name) {
  try {
    fs.unlinkSync(path.join(CAPTURE_DIR, name));
  } catch (e) {}
}

test("stamped filename keeps the extension and adds time + model", function () {
  const { stampTimeOnCapture } = require("../server.js");
  const stamped = stampTimeOnCapture(makeCapture("test-stamp-a.jpg"), "5:28 PM", "spark");
  try {
    assert.equal(stamped, "test-stamp-a--read-528PM--spark.jpg");
    assert.ok(fs.existsSync(path.join(CAPTURE_DIR, stamped)));
  } finally {
    scrub("test-stamp-a.jpg");
    scrub(stamped);
  }
});

test("stamped filename without a model keeps the old shape", function () {
  const { stampTimeOnCapture } = require("../server.js");
  const stamped = stampTimeOnCapture(makeCapture("test-stamp-b.jpg"), "5:28 PM");
  try {
    assert.equal(stamped, "test-stamp-b--read-528PM.jpg");
  } finally {
    scrub("test-stamp-b.jpg");
    scrub(stamped);
  }
});

test("stamped filename without a time is untouched", function () {
  const { stampTimeOnCapture } = require("../server.js");
  const name = makeCapture("test-stamp-c.jpg");
  try {
    assert.equal(stampTimeOnCapture(name, null, "spark"), name);
  } finally {
    scrub(name);
  }
});
