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

function render(result) {
  if (result && result.is_clock && result.time) {
    $("time-label").textContent = result.time;
  } else {
    $("time-label").textContent = "Not a clock";
  }
  $("quip").textContent = (result && result.quip) || "";
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

async function askWithSnapshot() {
  const video = $("preview");
  if (!stream || video.videoWidth === 0) {
    showErr("Camera is not running — upload a photo instead.");
    return;
  }
  const canvas = $("frame");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  showErr(null);
  $("time-label").textContent = "…";
  $("quip").textContent = "Grabbing a frame… hold still, preferably forever.";
  let res;
  try {
    res = await fetch("/api/read-clock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, question: $("question").value }),
    });
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

$("ask-btn").addEventListener("click", function () {
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
    stream.getTracks().forEach(function (t) {
      t.stop();
    });
    stream = null;
    $("preview").hidden = true;
    $("cam-btn").textContent = "Start camera";
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
