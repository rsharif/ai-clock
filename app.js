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
    $("time-label").textContent = "Couldn't see a thing — point it at a clock and Ask again";
  }
  renderDigital(result && result.digital);
}

var WAIT_LINES = [
  "Cross-referencing hand geometry with historical sundial databases…",
  "Consulting theoretical physicists on the exact meaning of 'quarter past'…",
  "Running deep learning models to determine which line is the short one…",
  "Decrypting legacy wall UI… Please hold.",
  "Analyzing circular spatial coordinates… 98% confident it's not a pizza.",
  "Simulating 10,000 timeline branches to verify if it's AM or PM…",
];
var waitTimer = null;

function startWaitLines() {
  stopWaitLines();
  const el = $("ask-status");
  let i = 0;
  el.textContent = WAIT_LINES[0];
  el.hidden = false;
  waitTimer = setInterval(function () {
    i = (i + 1) % WAIT_LINES.length;
    el.textContent = WAIT_LINES[i];
  }, 4500);
}

function stopWaitLines() {
  if (waitTimer) {
    clearInterval(waitTimer);
    waitTimer = null;
  }
  const el = $("ask-status");
  el.hidden = true;
  el.textContent = "";
}

async function askRing() {
  showErr(null);
  $("time-label").textContent = "…";
  startWaitLines();
  let res;
  try {
    res = await fetch("/api/read-clock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ring: true, source: "ring", question: QUESTION, model: $("model").value }),
    });
  } catch (e) {
    stopWaitLines();
    showErr("Backend unreachable — is the server running?");
    $("time-label").textContent = "—";
    return;
  }
  const data = await res.json().catch(function () {
    return null;
  });
  if (!res.ok) {
    stopWaitLines();
    showErr((data && data.error) || "Read failed.");
    $("time-label").textContent = "—";
    return;
  }
  stopWaitLines();
  render(data);
}

var currentPane = "synth";

$("ask-btn").addEventListener("click", function () {
  if (currentPane === "ring") askRing();
  else askSynthetic();
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

// Synthetic backup clock: an SVG dial with live hands, Asked through the
// same {image} path as uploads when Ring is down.
(function initSyntheticClock() {
  var ticks = $("synth-ticks");
  if (!ticks) return;
  var html = "";
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const a = (i / 60) * Math.PI * 2;
    const r1 = major ? 118 : 126;
    const r2 = 132;
    html +=
      '<line x1="' + (150 + r1 * Math.sin(a)).toFixed(1) +
      '" y1="' + (150 - r1 * Math.cos(a)).toFixed(1) +
      '" x2="' + (150 + r2 * Math.sin(a)).toFixed(1) +
      '" y2="' + (150 - r2 * Math.cos(a)).toFixed(1) +
      '" stroke="' + (major ? "#333" : "#bbb") +
      '" stroke-width="' + (major ? 4 : 2) + '"/>';
  }
  ticks.innerHTML = html;
})();

function paintSyntheticClock() {
  const now = new Date();
  const s = now.getSeconds() + now.getMilliseconds() / 1000;
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;
  $("synth-hour").setAttribute("transform", "rotate(" + (h * 30) + " 150 150)");
  $("synth-min").setAttribute("transform", "rotate(" + (m * 6) + " 150 150)");
  $("synth-sec").setAttribute("transform", "rotate(" + (s * 6) + " 150 150)");
}
setInterval(paintSyntheticClock, 250);
paintSyntheticClock();

function showPane(which) {
  currentPane = which;
  $("pane-ring").hidden = which !== "ring";
  $("pane-synth").hidden = which !== "synth";
  $("subtab-ring").classList.toggle("active", which === "ring");
  $("subtab-synth").classList.toggle("active", which === "synth");
}

$("subtab-ring").addEventListener("click", function () {
  showPane("ring");
});
$("subtab-synth").addEventListener("click", function () {
  showPane("synth");
  paintSyntheticClock();
});

function svgToPngDataUrl() {
  const svg = $("synth-clock");
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 600;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 600, 600);
        ctx.drawImage(img, 0, 0, 600, 600);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("could not rasterize the synthetic clock"));
    };
    img.src = url;
  });
}

async function askSynthetic() {
  showErr(null);
  $("time-label").textContent = "…";
  startWaitLines();
  let dataUrl;
  try {
    dataUrl = await svgToPngDataUrl();
  } catch (e) {
    stopWaitLines();
    showErr("Could not snapshot the synthetic clock — try again.");
    $("time-label").textContent = "—";
    return;
  }
  let res;
  try {
    res = await fetch("/api/read-clock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, source: "synthetic", question: QUESTION, model: $("model").value }),
    });
  } catch (e) {
    stopWaitLines();
    showErr("Backend unreachable — is the server running?");
    $("time-label").textContent = "—";
    return;
  }
  const data = await res.json().catch(function () {
    return null;
  });
  if (!res.ok) {
    stopWaitLines();
    showErr((data && data.error) || "Read failed.");
    $("time-label").textContent = "—";
    return;
  }
  stopWaitLines();
  render(data);
}

// Tabs: Clock vs Statistics vs Contribute.
var VIEWS = ["clock", "stats", "contribute"];

function showTab(which) {
  VIEWS.forEach(function (v) {
    $("view-" + v).hidden = v !== which;
    $("tab-" + v).classList.toggle("active", v === which);
  });
  $("sidenav").classList.remove("open");
  if (which === "stats") loadStats();
}

$("menu-btn").addEventListener("click", function () {
  $("sidenav").classList.toggle("open");
});

function fmtCell(v, suffix) {
  if (v === null || v === undefined) return "—";
  return typeof v === "number" && v % 1 !== 0 ? v.toFixed(1) + (suffix || "") : v + (suffix || "");
}

async function loadStats() {
  const status = $("stats-status");
  const body = $("stats-body");
  status.textContent = "loading…";
  body.innerHTML = "";
  const want = $("stats-source").value || "all";
  let res;
  try {
    res = await fetch("/api/stats?source=" + encodeURIComponent(want));
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
    status.textContent =
      want === "all" ? "no reads recorded yet — Ask the clock first." : "no " + want + " reads recorded yet.";
    return;
  }
  status.textContent = "";
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
$("stats-source").addEventListener("change", function () {
  loadStats();
});
