"use strict";

const $ = (id) => document.getElementById(id);

const CONFIG = {
  maxFileSize: 100 * 1024 * 1024,
  uploadTimeout: 5 * 60 * 1000,
  pollInterval: 2500,
  minClips: 2,
  maxClips: 6
};

let currentJob = null;
let activeRequest = null;
let pollToken = 0;

const uploadBtn = $("uploadBtn");
const fileInput = $("movieFile");
const fileName = $("fileName");

function setStatus(message) {
  const status = $("status");
  if (status) status.textContent = message;
}

function setButton(disabled, label) {
  if (!uploadBtn) return;
  uploadBtn.disabled = disabled;
  uploadBtn.textContent = label;
}

function showProgress() {
  const panel = $("processingPanel");
  if (panel) {
    panel.hidden = false;
    panel.classList.remove("hidden");
  }
}

function updateProgress(job) {
  showProgress();

  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));

  if ($("processingTitle")) {
    $("processingTitle").textContent =
      job.stage === "ready" ? "Your video is ready" :
      job.stage === "error" ? "Video processing failed" :
      "Creating your Short";
  }

  if ($("processingMessage")) {
    $("processingMessage").textContent =
      job.message || "Please wait while your video is processed.";
  }

  if ($("progressBar")) {
    $("progressBar").style.width = `${progress}%`;
  }

  if ($("progressNumber")) {
    $("progressNumber").textContent = `${progress}%`;
  }

  const stages = [
    "queued", "saving", "analysing",
    "selecting", "rendering", "finalising", "ready"
  ];

  const currentIndex = stages.indexOf(job.stage);

  document.querySelectorAll("#processingSteps [data-stage]").forEach((item) => {
    const index = stages.indexOf(item.dataset.stage);
    item.classList.toggle("completed", index !== -1 && index < currentIndex);
    item.classList.toggle("current", item.dataset.stage === job.stage);
  });
}

/* SOURCE TABS */

function selectSource(source) {
  document.querySelectorAll(".tab[data-source]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.source === source);
  });

  if ($("uploadPane")) $("uploadPane").hidden = source !== "upload";
  if ($("youtubePane")) $("youtubePane").hidden = source !== "youtube";

  setStatus(
    source === "youtube"
      ? "YouTube link processing is not connected yet. Upload a video you have permission to edit."
      : "Choose a video to get started."
  );
}

document.querySelectorAll(".tab[data-source]").forEach((tab) => {
  tab.addEventListener("click", () => selectSource(tab.dataset.source));
});

/* MANUAL SCENE CONTROLS */

function renumberScenes() {
  document.querySelectorAll(".manual-clip").forEach((row, index) => {
    const title = row.querySelector(".scene-title");
    if (title) title.textContent = `Scene ${index + 1}`;
  });
}

function addManualScene() {
  const list = $("manualClipList");
  if (!list) return;

  if (list.querySelectorAll(".manual-clip").length >= CONFIG.maxClips) {
    setStatus("You can select a maximum of 6 scenes.");
    return;
  }

  const row = document.createElement("div");
  row.className = "manual-clip";
  row.style.cssText = "margin:14px 0;padding:12px;border:1px solid rgba(128,128,128,.3);border-radius:10px;";

  row.innerHTML = `
    <strong class="scene-title"></strong>
    <label>Start time (seconds)
      <input class="field manual-start" type="number" min="0" step="0.1" placeholder="e.g. 50">
    </label>
    <label>End time (seconds)
      <input class="field manual-end" type="number" min="0" step="0.1" placeholder="e.g. 65">
    </label>
    <button class="secondary remove-scene" type="button">Remove scene</button>
  `;

  list.appendChild(row);
  renumberScenes();
}

function getManualClips() {
  const rows = document.querySelectorAll(".manual-clip");

  if (rows.length < CONFIG.minClips || rows.length > CONFIG.maxClips) {
    throw new Error("Please select between 2 and 6 scenes.");
  }

  const clips = [];

  rows.forEach((row, index) => {
    const start = Number(row.querySelector(".manual-start")?.value);
    const end = Number(row.querySelector(".manual-end")?.value);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    ) {
      throw new Error(`Enter valid start and end times for Scene ${index + 1}.`);
    }

    if (end - start < 2 || end - start > 25) {
      throw new Error(`Scene ${index + 1} must be between 2 and 25 seconds.`);
    }

    clips.push({
      start,
      end,
      description: `Selected scene ${index + 1}`
    });
  });

  return clips;
}

const clipMode = $("clipMode");
const manualPanel = $("manualPanel");

if (clipMode && manualPanel) {
  clipMode.addEventListener("change", () => {
    manualPanel.hidden = clipMode.value !== "manual";
    setStatus(
      clipMode.value === "manual"
        ? "Manual mode selected. Enter your scene timestamps."
        : "Auto mode selected. AI will select the scenes."
    );
  });
}

if ($("addManualClip")) {
  $("addManualClip").addEventListener("click", addManualScene);
}

if ($("manualClipList")) {
  $("manualClipList").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-scene");
    if (!button) return;

    const rows = document.querySelectorAll(".manual-clip");

    if (rows.length <= CONFIG.minClips) {
      setStatus("Manual mode needs at least 2 scenes.");
      return;
    }

    button.closest(".manual-clip").remove();
    renumberScenes();
  });
}

/* FILE SELECTION */

if (fileInput) {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];

    if (fileName) {
      fileName.textContent = file ? file.name : "No video selected";
    }

    if (file) {
      setStatus(`Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  });
}

/* UPLOAD */

function uploadVideo(file, mode, manualClips) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();

    formData.append("mode", mode);

    if (mode === "manual") {
      formData.append("manualClips", JSON.stringify(manualClips));
    }

    formData.append("movie", file);

    const xhr = new XMLHttpRequest();
    activeRequest = xhr;

    xhr.open("POST", "/api/create-short", true);
    xhr.timeout = CONFIG.uploadTimeout;

    xhr.upload.onloadstart = () => {
      setStatus("Upload started. Sending your video to the server...");
    };

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const percent = Math.round((event.loaded / event.total) * 100);

        updateProgress({
          stage: "saving",
          progress: Math.min(10, Math.round(percent / 10)),
          message: `Uploading video: ${percent}%`
        });

        setStatus(`Uploading video: ${percent}%`);
      } else {
        setStatus("Uploading video...");
      }
    };

    xhr.upload.onload = () => {
      setStatus("Upload sent. Waiting for server confirmation...");
    };

    xhr.onload = () => {
      activeRequest = null;

      let data;

      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(`Server returned an invalid response (HTTP ${xhr.status}).`));
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `Upload failed (HTTP ${xhr.status}).`));
        return;
      }

      if (!data.ok || !data.id) {
        reject(new Error(data.error || "The server did not create a processing job."));
        return;
      }

      resolve(data);
    };

    xhr.onerror = () => {
      activeRequest = null;
      reject(new Error("Network error. Check your connection and try again."));
    };

    xhr.ontimeout = () => {
      activeRequest = null;
      reject(new Error("Upload timed out. Try a smaller video or stronger connection."));
    };

    xhr.onabort = () => {
      activeRequest = null;
      reject(new Error("Upload was cancelled."));
    };

    xhr.send(formData);
  });
}

/* JOB STATUS */

async function checkJob(jobId, token) {
  while (currentJob === jobId && token === pollToken) {
    const response = await fetch(
      `/api/jobs/${encodeURIComponent(jobId)}`,
      { cache: "no-store" }
    );

    let job;

    try {
      job = await response.json();
    } catch {
      throw new Error("The server returned an invalid job status.");
    }

    if (!response.ok) {
      throw new Error(job.error || `Could not check job status (HTTP ${response.status}).`);
    }

    updateProgress(job);

    if (job.stage === "ready" && job.result) {
      showResult(job.result);
      setStatus("Your video is ready.");
      return;
    }

    if (job.stage === "error" || job.error) {
      throw new Error(job.message || job.error || "Video processing failed.");
    }

    await new Promise((resolve) => setTimeout(resolve, CONFIG.pollInterval));
  }
}

/* RESULT */

function showResult(result) {
  const panel = $("shortPreview");
  const video = $("shortVideo");
  const download = $("shortDownload");

  if (!panel || !video || !download) {
    setStatus("The video is ready, but the preview section is missing.");
    return;
  }

  if (!result.videoUrl || !result.downloadUrl) {
    panel.hidden = false;
    panel.classList.remove("hidden");
    setStatus("The server did not return video links.");
    return;
  }

  panel.hidden = false;
  panel.classList.remove("hidden");

  video.pause();
  video.removeAttribute("src");
  video.load();

  video.src = result.videoUrl;
  video.load();

  video.onerror = () => {
    setStatus("The video preview could not load. Try creating it again.");
  };

  video.onloadedmetadata = () => {
    setStatus("Preview loaded. Your video is ready to watch or download.");
  };

  download.href = result.downloadUrl;
  download.hidden = false;

  if ($("shortTitle")) $("shortTitle").textContent = "Your Short is ready";

  const details = $("clipDetails");

  if (details) {
    details.replaceChildren();

    if (Array.isArray(result.clips)) {
      result.clips.forEach((clip, index) => {
        const line = document.createElement("p");
        const start = Number(clip.start || 0).toFixed(1);
        const end = Number(clip.end || 0).toFixed(1);

        line.textContent =
          `Clip ${index + 1}: ${start}s – ${end}s` +
          (clip.reason ? ` — ${clip.reason}` : "");

        details.appendChild(line);
      });
    }
  }

  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* CREATE VIDEO */

async function createShort() {
  if (activeRequest) {
    setStatus("An upload is already running.");
    return;
  }

  const file = fileInput?.files?.[0];

  if (!file) {
    setStatus("Please choose a video first.");
    return;
  }

  if (!file.type.startsWith("video/")) {
    setStatus("That file does not appear to be a supported video.");
    return;
  }

  if (file.size > CONFIG.maxFileSize) {
    setStatus("This video is larger than the current 100 MB upload limit.");
    return;
  }

  const mode = $("clipMode")?.value || "auto";
  let manualClips = [];

  try {
    if (mode === "manual") manualClips = getManualClips();
  } catch (error) {
    setStatus(error.message);
    return;
  }

  pollToken++;
  const token = pollToken;
  currentJob = null;

  setButton(true, "Uploading...");

  if ($("shortPreview")) {
    $("shortPreview").hidden = true;
    $("shortPreview").classList.add("hidden");
  }

  showProgress();

  updateProgress({
    stage: "queued",
    progress: 0,
    message: "Preparing your video..."
  });

  try {
    const data = await uploadVideo(file, mode, manualClips);

    currentJob = data.id;

    setStatus(
      mode === "manual"
        ? "Upload confirmed. Your selected scenes are being processed."
        : "Upload confirmed. AI is now analysing your video."
    );

    await checkJob(data.id, token);
  } catch (error) {
    setStatus(error.message || "Something went wrong.");

    updateProgress({
      stage: "error",
      progress: 0,
      message: error.message || "Processing failed."
    });
  } finally {
    if (token === pollToken) setButton(false, "Create my Short");
  }
}

if (uploadBtn) {
  uploadBtn.addEventListener("click", createShort);
}

/* COPY NARRATION */

if ($("copyBtn")) {
  $("copyBtn").addEventListener("click", async () => {
    const script = $("script")?.value || "";

    if (!script.trim()) {
      setStatus("There is no narration text to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(script);
      setStatus("Narration copied.");
    } catch {
      setStatus("Copy failed. Please copy the text manually.");
    }
  });
}

selectSource("upload");
