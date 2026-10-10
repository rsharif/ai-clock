"use strict";

// /api/config serves the public player URL so deployments can point the
// browser at the cloud go2rtc address without code changes. Drives the
// Express app directly (no socket) so it runs in sandboxes that block listen.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.RING_PLAYER_URL = "https://cam.example.com/stream.html?src=clockcam";
const app = require("../server.js");

function get(path) {
  return new Promise(function (resolve, reject) {
    const req = { method: "GET", url: path, headers: {} };
    const res = {
      statusCode: 200,
      body: "",
      status: function (c) {
        this.statusCode = c;
        return this;
      },
      json: function (o) {
        resolve({ status: this.statusCode, body: o });
      },
      setHeader: function () {},
    };
    try {
      app.handle(req, res, function (e) {
        reject(e || new Error("unhandled: " + path));
      });
    } catch (e) {
      reject(e);
    }
  });
}

test("/api/config returns the RING_PLAYER_URL env value", async function () {
  const r = await get("/api/config");
  assert.equal(r.status, 200);
  assert.equal(r.body.ringPlayerUrl, "https://cam.example.com/stream.html?src=clockcam");
});
