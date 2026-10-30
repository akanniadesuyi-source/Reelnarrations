
"use strict";

const $ = (id) => document.getElementById(id);

const CONFIG = {
  maxFileSize: 100 * 1024 * 1024,
  uploadTimeout: 5 * 60 * 1000,
  pollInterval: 2500
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
  if (panel) panel.hidden = false;
}

function updateProgress(job) {
  showProgress();

  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));

  if ($("processingTitle")) {
    $("processingTitle").textContent =
      job.stage === "ready" ? "Your video is ready" : "Creating your Short";
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
    "queued",
    "saving",
    "analysing",
    "selecting",
    "rendering",
    "ready"
  ];

  const currentIndex = stages.indexOf(job.stage);

  document.querySelectorAll("#processingSteps [data-stage]").forEach((item) => {
    const index = stages.indexOf(item.dataset.stage);

    item.classList.toggle(
      "completed",
      index !== -1 && index < currentIndex
    );

    item.classList.toggle(
      "current",
      item.dataset.stage === job.stage
    );
  });
}

function selectSource(source) {
  document.querySelectorAll(".tab[data-source]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.source === source);
  });

  if ($("uploadPane")) {
    $("uploadPane").hidden = source !== "upload";
  }

  if ($("youtubePane")) {
    $("youtubePane").hidden = source !== "youtube";
  }

  if (source === "youtube") {
    setStatus(
      "YouTube link processing is not connected yet. Upload an authorised video file for now."
    );
  } else {
    setStatus("Choose a video to get started.");
  }
}

document.querySelectorAll(".tab[data-source]").forEach((tab) => {
  tab.addEventListener("click", () => {
    selectSource(tab.dataset.source);
  });
});

if (fileInput) {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];

    if (fileName) {
      fileName.textContent = file ? file.name : "No video selected";
    }

    if (file) {
      setStatus(
        `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`
      );
    }
  });
}

function uploadVideo(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
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
        const percent = Math.round(
          (event.loaded / event.total) * 100
        );

        updateProgress({
          stage: "saving",
          progress: Math.min(10, Math.round(percent / 10)),
          message: `Uploading video: ${percent}%`
        });

        setStatus(`Uploading video: ${percent}%`);
      } else {
        setStatus("Uploading video... waiting for upload progress.");
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
        reject(
          new Error(
            `Server returned an invalid response (HTTP ${xhr.status}).`
          )
        );
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            data.error || `Server upload failed (HTTP ${xhr.status}).`
          )
        );
        return;
      }

      if (!data.ok || !data.id) {
        reject(
          new Error(data.error || "The server did not create a processing job.")
        );
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
      reject(
        new Error("Upload timed out. Try a smaller video or a stronger connection.")
      );
    };

    xhr.onabort = () => {
      activeRequest = null;
      reject(new Error("Upload was cancelled."));
    };

    xhr.send(formData);
  });
}

async function checkJob(jobId, token) {
  while (currentJob === jobId && token === pollToken) {
    try {
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
        throw new Error(
          job.error || `Could not check job status (HTTP ${response.status}).`
        );
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
    } catch (error) {
      if (token !== pollToken) return;
      throw error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, CONFIG.pollInterval);
    });
  }
}

function showResult(result) {
  const panel = $("shortPreview");
  if (!panel) return;

  panel.hidden = false;

  const video = $("shortVideo");
  const download = $("shortDownload");

  if (video && result.videoUrl) {
    video.src = result.videoUrl;
    video.load();
  }

  if (download && result.downloadUrl) {
    download.href = result.downloadUrl;
    download.hidden = false;
  }

  if ($("shortTitle")) {
    $("shortTitle").textContent = "Your Short is ready";
  }

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

  panel.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

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

  pollToken++;
  const token = pollToken;
  currentJob = null;

  setButton(true, "Uploading...");

  if ($("shortPreview")) {
    $("shortPreview").hidden = true;
  }

  showProgress();

  updateProgress({
    stage: "queued",
    progress: 0,
    message: "Preparing your video..."
  });

  try {
    const data = await uploadVideo(file);

    currentJob = data.id;

    setStatus("Upload confirmed. AI is now analysing your video.");

    await checkJob(data.id, token);

  } catch (error) {
    setStatus(error.message || "Something went wrong.");

    updateProgress({
      stage: "error",
      progress: 0,
      message: error.message || "Processing failed."
    });

  } finally {
    if (token === pollToken) {
      setButton(false, "Create my Short");
    }
  }
}

if (uploadBtn) {
  uploadBtn.addEventListener("click", createShort);
}

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
    
