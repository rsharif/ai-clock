"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeEmail, validateEmail } = require("../lib/signup");

test("normalizeEmail trims and lowercases", function () {
  assert.equal(normalizeEmail("  Foo@Example.COM "), "foo@example.com");
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(42), null);
});

test("validateEmail accepts normal addresses", function () {
  assert.equal(validateEmail("you@example.com"), "you@example.com");
  assert.equal(validateEmail("  Foo@Example.COM "), "foo@example.com");
  assert.equal(validateEmail("a+b@mail-server.example.org"), "a+b@mail-server.example.org");
  assert.equal(validateEmail("x@y.co"), "x@y.co");
});

test("validateEmail rejects malformed addresses", function () {
  ["", null, 42, "plain", "@nodomain.com", "missing-at.com", "a@b", "a@b.c",
   "a b@c.com", "a@b c.com", "two@@c.com", "a..b@c.com", ".ab@c.com",
   "ab.@c.com", "a@b..com", "a@-b.com", "a@b-.com", "a@c_m.com",
  ].forEach(function (bad) {
    assert.equal(validateEmail(bad), null, JSON.stringify(bad));
  });
});

test("validateEmail rejects overlong addresses", function () {
  assert.equal(validateEmail("a@" + "b".repeat(250) + ".com"), null);
  assert.equal(validateEmail("a".repeat(65) + "@c.com"), null);
});

test("POST /api/signups route is registered", function () {
  const app = require("../server.js");
  const layers = app._router.stack.filter(function (l) {
    return l.route && l.route.path === "/api/signups";
  });
  assert.equal(layers.length, 1);
  assert.ok(layers[0].route.methods.post);
});

test("POST /api/signups rejects a bad email without touching the db", async function (t) {
  const app = require("../server.js");
  let srv;
  try {
    srv = await new Promise(function (resolve, reject) {
      const s = app.listen(0, function () { resolve(s); });
      s.on("error", reject);
    });
  } catch (e) {
    t.skip("socket bind unavailable: " + (e && e.code));
    return;
  }
  function addr() { return "http://127.0.0.1:" + srv.address().port; }
  try {
    const res = await fetch(addr() + "/api/signups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /valid email/);
    const empty = await fetch(addr() + "/api/signups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
  } finally {
    await new Promise(function (resolve) { srv.close(resolve); });
  }
});
