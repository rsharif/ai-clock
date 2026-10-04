"use strict";

/* AI Clock frontend.
 * Source A (upload): file input -> multipart POST /api/read-clock.
 * Source B (live): getUserMedia preview -> canvas snapshot -> JSON POST
 *   {image: dataUrl} to the SAME endpoint. The backend can't tell them apart.
 */

function $(id) {
  return document.getElementById(id);
}

let stream = null;
let mirrored = false;
let lastReading = null;
let ringMode = false;
// go2rtc's own player page (auto-selects WebRTC/MSE/HLS). Same machine here;
// LAN or Tailscale deployments change this host.
const RING_PLAYER_URL = "http://localhost:1984/stream.html?src=clockcam";

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
  lastReading = result;
  if (result && result.is_clock && result.time) {
    $("time-label").textContent = result.time;
  } else {
    $("time-label").textContent = "Not a clock";
  }
  renderDigital(result && result.digital);
  $("quip").textContent = (result && result.quip) || "";
}

// "convert to digital" reuses the last reading: no new photo, no model call.
function maybeConvertLocally() {
  const q = $("question").value || "";
  if (!/digital|convert/i.test(q)) return false;
  if (!lastReading || !lastReading.is_clock || !lastReading.time) {
    showErr("Read a clock first, then ask me to convert it.");
    return true;
  }
  showErr(null);
  const d = lastReading.digital;
  $("time-label").textContent = (d && d.twelve) || lastReading.time;
  renderDigital(d);
  $("quip").textContent = "Converted from the last reading — no new photo needed.";
  return true;
}

async function askWithForm(file) {
  showErr(null);
  $("time-label").textContent = "…";
  $("quip").textContent = "Squinting at your offering…";
  const fd = new FormData();
  fd.append("image", file);
  fd.append("question", $("question").value);
  let res;
  try {
    res = await fetch("/api/read-clock", { method: "POST", body: fd });
  } catch (e) {
    showErr("Backend unreachable — is the server running?");
    $("time-label").textContent = "—";
    return;
  }
  const data = await res.json().catch(function () {
    return null;
  });
  if (!res.ok) {
    showErr((data && data.error) || "Read failed.");
    $("time-label").textContent = "—";
    return;
  }
  render(data);
}

function videoReady(video) {
  return Boolean(stream) && video.videoWidth !== 0;
}

async function waitForVideo(video) {
  if (videoReady(video)) return true;
  if (!stream) return false;
  // Stream just started but metadata hasn't landed yet — wait up to 3s.
  await new Promise(function (resolve) {
    const done = function () {
      video.removeEventListener("loadedmetadata", done);
      resolve();
    };
    video.addEventListener("loadedmetadata", done);
    setTimeout(done, 3000);
  });
  return videoReady(video);
}

async function askWithSnapshot() {
  const video = $("preview");
  if (!(await waitForVideo(video))) {
    showErr("Camera is not running — upload a photo instead.");
    return;
  }
  // Upscale 2x: adds no detail, but gives the vision model more pixels
  // of thin clock hands to work with.
  const SCALE = 2;
  const canvas = $("frame");
  canvas.width = video.videoWidth * SCALE;
  canvas.height = video.videoHeight * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.save();
  if (mirrored) {
    // Match what the mirrored preview shows, so the model reads the same image.
    ctx.translate(canvas.width, 0);
    ctx.scale(-SCALE, SCALE);
  } else {
    ctx.scale(SCALE, SCALE);
  }
  ctx.drawImage(video, 0, 0);
  ctx.restore();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  await postRead({ image: dataUrl, question: $("question").value },
    "Grabbing a frame… hold still, preferably forever.");
}

// Shared POST + render for every source. Ring mode sends no pixels: the
// backend pulls the gateway frame itself. Slow models get progress updates
// so the page never looks dead.
async function postRead(payload, waitingQuip) {
  showErr(null);
  $("time-label").textContent = "…";
  $("quip").textContent = waitingQuip;
  const started = Date.now();
  const stages = [
    "Still squinting…",
    "Comparing hand lengths…",
    "Double-checking the hour hand…",
    "The model is thinking hard…",
  ];
  let n = 0;
  const tick = setInterval(function () {
    const s = Math.floor((Date.now() - started) / 1000);
    $("quip").textContent =
      stages[Math.min(n++, stages.length - 1)] + " (" + s + "s)";
  }, 7000);
  const done = function () {
    clearInterval(tick);
  };
  let res;
  try {
    res = await fetch("/api/read-clock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    done();
    showErr("Backend unreachable — is the server running?");
    $("time-label").textContent = "—";
    return;
  }
  const data = await res.json().catch(function () {
    return null;
  });
  done();
  if (!res.ok) {
    showErr((data && data.error) || "Read failed.");
    $("time-label").textContent = "—";
    return;
  }
  render(data);
}

async function askRing() {
  await postRead({ ring: true, question: $("question").value },
    "Asking the Ring camera… waking it up if it dozed off.");
}

$("ask-btn").addEventListener("click", function () {
  if (maybeConvertLocally()) return;
  if (ringMode) {
    askRing();
    return;
  }
  if (stream) {
    askWithSnapshot();
    return;
  }
  const file = $("file").files[0];
  if (!file) {
    showErr("Upload a clock photo first — or start the camera below.");
    return;
  }
  askWithForm(file);
});

$("cam-btn").addEventListener("click", async function () {
  showErr(null);
  if (stream) {
    stopWebcam();
    $("cam-status").textContent = "camera off — upload works without it";
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showErr("This browser has no camera API. Upload a photo instead.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (e) {
    const name = (e && e.name) || "";
    if (name === "NotAllowedError") {
      showErr("Camera permission denied. Allow access or upload a photo.");
    } else if (name === "NotFoundError") {
      showErr("No camera found on this device. Upload a photo instead.");
    } else {
      showErr("Could not start the camera. Upload a photo instead.");
    }
    return;
  }
  const video = $("preview");
  video.srcObject = stream;
  video.hidden = false;
  $("cam-btn").textContent = "Stop camera";
  $("cam-status").textContent = "live — Ask grabs the current frame";
});

$("mirror-btn").addEventListener("click", function () {
  mirrored = !mirrored;
  $("preview").classList.toggle("mirrored", mirrored);
  $("mirror-btn").textContent = mirrored ? "Mirror: on" : "Mirror: off";
});

function stopWebcam() {
  if (!stream) return;
  stream.getTracks().forEach(function (t) {
    t.stop();
  });
  stream = null;
  $("preview").hidden = true;
  $("cam-btn").textContent = "Start camera";
}

$("ring-btn").addEventListener("click", function () {
  showErr(null);
  ringMode = !ringMode;
  if (ringMode) {
    stopWebcam();
    $("cam-status").textContent = "ring live — Ask grabs the gateway frame";
    const view = $("ringview");
    view.src = RING_PLAYER_URL;
    view.hidden = false;
    $("preview").hidden = true;
    $("ring-btn").textContent = "Ring: on";
  } else {
    $("ringview").hidden = true;
    $("ringview").removeAttribute("src");
    $("cam-status").textContent = "camera off — upload works without it";
    $("ring-btn").textContent = "Watch Ring";
  }
});
