const $ = id => document.getElementById(id);

let currentAudioUrl = null;
let currentJob = null;
let polling = false;

function setStatus(message, error = false) {
  $("status").textContent = message;
  $("status").style.color = error ? "#ff7777" : "#63d6a3";
}

function showProgress() {
  let panel = $("processingPanel");

  if (!panel) {
    panel = document.createElement("section");
    panel.id = "processingPanel";
    panel.className = "panel";
    panel.innerHTML = `
      <p class="eyebrow">VIDEO PROCESSING</p>
      <h2 id="processingTitle">Preparing your video</h2>
      <p id="processingMessage">Please wait...</p>
      <div style="height:10px;background:#29283b;border-radius:20px;overflow:hidden;margin:18px 0">
        <div id="progressBar" style="height:100%;width:0%;background:#a78bfa;transition:width .4s"></div>
      </div>
      <strong id="progressNumber">0%</strong>
      <div id="processingSteps" style="margin-top:18px;line-height:2"></div>
    `;

    $("status").parentNode.insertBefore(
      panel,
      $("status").parentNode.nextSibling
    );
  }

  panel.classList.remove("hidden");
  return panel;
}

function updateProgress(job) {
  const stages = [
    ["queued", "Waiting to start"],
    ["saving", "Saving video"],
    ["analysing", "AI analysing video"],
    ["selecting", "Selecting highlights"],
    ["rendering", "Creating vertical Short"],
    ["ready", "Finished"]
  ];

  $("processingTitle").textContent =
    job.stage === "failed" ? "Processing failed" :
    job.stage === "ready" ? "Your Short is ready!" :
    "Creating your Short";

  $("processingMessage").textContent = job.message || "Working...";

  $("progressBar").style.width = `${job.progress || 0}%`;
  $("progressNumber").textContent = `${job.progress || 0}%`;

  $("processingSteps").innerHTML = stages.map(([stage, label]) => {
    const complete = stages.findIndex(item => item[0] === stage) <
      stages.findIndex(item => item[0] === job.stage);

    const active = stage === job.stage;
    const symbol = complete ? "✓" : active ? "●" : "○";

    return `<div style="color:${complete ? "#63d6a3" : active ? "#c4b5fd" : "#888"}">${symbol} ${label}</div>`;
  }).join("");
}

async function checkJob(jobId) {
  if (polling) return;
  polling = true;

  try {
    while (currentJob === jobId) {
      const response = await fetch(`/api/jobs/${jobId}`);
      const job = await response.json();

      if (!response.ok) {
        throw new Error(job.error || "Could not check processing status.");
      }

      updateProgress(job);

      if (job.stage === "failed") {
        setStatus(job.message || "Video processing failed.", true);
        return;
      }

      if (job.stage === "ready") {
        showResult(job.result);
        setStatus("Your video is ready.");
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    polling = false;
  }
}

function showResult(result) {
  let panel = $("shortPreview");

  if (!panel) {
    panel = document.createElement("section");
    panel.id = "shortPreview";
    panel.className = "panel";

    $("processingPanel").parentNode.insertBefore(
      panel,
      $("processingPanel").nextSibling
    );
  }

  panel.innerHTML = `
    <p class="eyebrow">YOUR FINISHED VIDEO</p>
    <h2 id="shortTitle"></h2>
    <video id="shortVideo" controls playsinline
      style="width:100%;max-height:600px;background:#000;border-radius:12px;margin-top:14px">
    </video>
    <h3 style="margin-top:20px">Selected moments</h3>
    <div id="clipDetails"></div>
    <a id="shortDownload" class="primary"
      style="display:block;text-align:center;text-decoration:none;margin-top:18px"
      download="reelnarrator-short.mp4">
      Download finished Short
    </a>
  `;

  $("shortTitle").textContent = result.title || "Your Short";
  $("shortVideo").src = result.downloadUrl;
  $("shortDownload").href = result.downloadUrl;

  result.clips.forEach((clip, index) => {
    const item = document.createElement("p");
    item.style.padding = "10px 0";
    item.style.borderBottom = "1px solid #29283b";

    item.textContent =
      `${index + 1}. ${Number(clip.start).toFixed(1)}s – ${Number(clip.end).toFixed(1)}s: ${clip.reason}`;

    $("clipDetails").appendChild(item);
  });

  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth" });
}

async function createShort(file) {
  if (!file) {
    setStatus("Choose a video file first.", true);
    return;
  }

  if (!file.type.startsWith("video/")) {
    setStatus("Please select a video file.", true);
    return;
  }

  currentJob = null;

  const button = $("uploadBtn");
  button.disabled = true;
  button.textContent = "Uploading...";

  $("shortPreview")?.classList.add("hidden");

  showProgress();
  updateProgress({
    stage: "queued",
    progress: 0,
    message: "Preparing your upload."
  });

  const form = new FormData();
  form.append("movie", file);

  const request = new XMLHttpRequest();
  request.open("POST", "/api/create-short");

  request.upload.onprogress = event => {
    if (event.lengthComputable) {
      const percent = Math.round(event.loaded / event.total * 100);

      updateProgress({
        stage: "saving",
        progress: Math.min(percent, 10),
        message: `Uploading your video: ${percent}%`
      });
    }
  };

  request.onload = async () => {
    button.disabled = false;
    button.textContent = "Analyse video & create Short";

    try {
      const data = JSON.parse(request.responseText);

      if (request.status !== 202 || !data.id) {
        throw new Error(data.error || "Could not start processing.");
      }

      currentJob = data.id;

      setStatus("Upload complete. AI processing has started.");

      await checkJob(data.id);

    } catch (error) {
      setStatus(error.message, true);
    }
  };

  request.onerror = () => {
    button.disabled = false;
    button.textContent = "Analyse video & create Short";
    setStatus("Connection failed. Please try again.", true);
  };

  request.send(form);
}

$("movieFile").addEventListener("change", () => {
  const file = $("movieFile").files[0];

  $("fileName").textContent = file
    ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`
    : "No video selected";
});

$("uploadBtn").addEventListener("click", () => {
  createShort($("movieFile").files[0]);
});

$("copyBtn").addEventListener("click", async () => {
  const text = $("script").value.trim();

  if (!text) {
    setStatus("There is no script to copy.", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Script copied.");
  } catch {
    setStatus("Please select and copy the script manually.");
  }
});

$("voiceBtn").addEventListener("click", async () => {
  const text = $("script").value.trim();

  if (!text) {
    setStatus("Write a narration first.", true);
    return;
  }

  const button = $("voiceBtn");
  button.disabled = true;
  button.textContent = "Generating...";

  try {
    const response = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Voice generation failed.");
    }

    const blob = await response.blob();

    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);

    currentAudioUrl = URL.createObjectURL(blob);

    $("audio").src = currentAudioUrl;
    $("audio").classList.remove("hidden");

    $("downloadAudio").href = currentAudioUrl;
    $("downloadAudio").classList.remove("hidden");

    setStatus("Voice generated successfully.");

  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Generate voice";
  }
});
      
