"use strict";

/* AI Clock frontend (Ring-only).
 * The page opens on the live Ring stream; "What time is it now?" asks the
 * backend, which pulls the gateway frame itself and returns the reading
 * plus a digital conversion.
 */

// go2rtc's own player page (auto-selects WebRTC/MSE/HLS). Same machine here;
// LAN or Tailscale deployments change this host.
var RING_PLAYER_URL = "http://localhost:1984/stream.html?src=clockcam";
var QUESTION = "What time is it right now?";

function $(id) {
  return document.getElementById(id);
}

function showErr(msg) {
  const el = $("err");
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function renderDigital(d) {
  const el = $("digital");
  if (!d || (!d.twelve && !d.twentyFour)) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = "Digital — 12-hour: " + d.twelve + " · 24-hour: " + d.twentyFour;
}

function render(result) {
  if (result && result.is_clock && result.time) {
    $("time-label").textContent = result.time;
  } else {
    $("time-label").textContent = "Not a clock";
  }
  renderDigital(result && result.digital);
}

async function askRing() {
  showErr(null);
  $("time-label").textContent = "…";
  const started = Date.now();
  const stages = [
    "Asking the Ring camera…",
    "Still squinting…",
    "Comparing hand lengths…",
    "The model is thinking hard…",
  ];
  let n = 0;
  const tick = setInterval(function () {
    const s = Math.floor((Date.now() - started) / 1000);
    $("cam-status").textContent =
      stages[Math.min(n++, stages.length - 1)] + " (" + s + "s)";
  }, 7000);
  let res;
  try {
    res = await fetch("/api/read-clock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ring: true, question: QUESTION, model: $("model").value }),
    });
  } catch (e) {
    clearInterval(tick);
    showErr("Backend unreachable — is the server running?");
    $("time-label").textContent = "—";
    $("cam-status").textContent = "ring live — Ask grabs the gateway frame";
    return;
  }
  const data = await res.json().catch(function () {
    return null;
  });
  clearInterval(tick);
  $("cam-status").textContent = "ring live — Ask grabs the gateway frame";
  if (!res.ok) {
    showErr((data && data.error) || "Read failed.");
    $("time-label").textContent = "—";
    return;
  }
  render(data);
}

$("ask-btn").addEventListener("click", function () {
  askRing();
});

// Autoplay the wall clock on page open: visitors land on the live stream.
// The player host comes from the backend so deployments (Render, VPS) can
// point at the public go2rtc address; localhost default keeps local dev working.
fetch("/api/config")
  .then(function (res) {
    return res.json();
  })
  .then(function (cfg) {
    if (cfg && cfg.ringPlayerUrl) RING_PLAYER_URL = cfg.ringPlayerUrl;
  })
  .catch(function () {})
  .then(function () {
    $("ringview").src = RING_PLAYER_URL;
  });
$("cam-status").textContent = "ring live — Ask grabs the gateway frame";

// Tabs: Clock vs Statistics vs Contribute.
var VIEWS = ["clock", "stats", "contribute"];

function showTab(which) {
  VIEWS.forEach(function (v) {
    $("view-" + v).hidden = v !== which;
    $("tab-" + v).classList.toggle("active", v === which);
  });
  if (which === "stats") loadStats();
}

function fmtCell(v, suffix) {
  if (v === null || v === undefined) return "—";
  return typeof v === "number" && v % 1 !== 0 ? v.toFixed(1) + (suffix || "") : v + (suffix || "");
}

async function loadStats() {
  const status = $("stats-status");
  const body = $("stats-body");
  status.textContent = "loading…";
  body.innerHTML = "";
  let res;
  try {
    res = await fetch("/api/stats");
  } catch (e) {
    status.textContent = "backend unreachable — is the server running?";
    return;
  }
  const data = await res.json().catch(function () {
    return null;
  });
  if (!res.ok) {
    status.textContent = (data && data.error) || "Stats unavailable.";
    return;
  }
  const rows = (data && data.rows) || [];
  if (!rows.length) {
    status.textContent = "no reads recorded yet — Ask the clock first.";
    return;
  }
  status.textContent = (data.totalReads || rows.length) + " reads recorded";
  body.innerHTML = rows
    .map(function (r) {
      return (
        "<tr><td>" +
        r.model +
        "</td><td>" +
        r.reads +
        "</td><td>" +
        fmtCell(r.accuracyPct, "%") +
        "</td><td>" +
        fmtCell(r.meanPromptTokens) +
        "</td><td>" +
        fmtCell(r.meanCompletionTokens) +
        "</td><td>" +
        (r.p90ResponseMs === null || r.p90ResponseMs === undefined
          ? "—"
          : (r.p90ResponseMs / 1000).toFixed(1) + "s") +
        "</td></tr>"
      );
    })
    .join("");
}

$("tab-clock").addEventListener("click", function () {
  showTab("clock");
});
$("tab-stats").addEventListener("click", function () {
  showTab("stats");
});
$("tab-contribute").addEventListener("click", function () {
  showTab("contribute");
});
$("stats-refresh").addEventListener("click", function () {
  loadStats();
});
