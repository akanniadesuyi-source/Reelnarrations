const state = {
  uploadId: null,
  duration: 0,
  sceneChanges: [],
  clips: [],
  busy: false
};

const $ = id => document.getElementById(id);

function show(element, visible = true) {
  element.classList.toggle("hidden", !visible);
}

function setStatus(id, message, error = false) {
  const element = $(id);
  element.textContent = message;
  element.classList.toggle("error", error);
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function parseTime(value) {
  const text = String(value || "").trim();

  if (!text) return NaN;

  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }

  const parts = text.split(":").map(Number);

  if (parts.some(part => !Number.isFinite(part) || part < 0)) {
    return NaN;
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return NaN;
}

function getRequestedDuration() {
  const selected = $("clipDuration").value;

  if (selected === "custom") {
    return Math.min(300, Math.max(5, Number($("customDuration").value) || 45));
  }

  return Number(selected) || 45;
}

function renderClipList() {
  const list = $("clipList");
  list.innerHTML = "";

  state.clips.forEach((clip, index) => {
    const card = document.createElement("article");
    card.className = "clip-card";

    const heading = document.createElement("div");
    heading.className = "clip-card-heading";

    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "clip-select";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = clip.selected !== false;
    checkbox.addEventListener("change", () => {
      clip.selected = checkbox.checked;
      updateRenderButton();
    });

    const title = document.createElement("strong");
    title.textContent = `Clip ${index + 1}`;

    checkboxLabel.append(checkbox, title);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.clips.splice(index, 1);
      renderClipList();
    });

    heading.append(checkboxLabel, remove);

    const fields = document.createElement("div");
    fields.className = "field-grid";

    const startLabel = document.createElement("label");
    startLabel.className = "field";
    startLabel.textContent = "Start time";

    const startInput = document.createElement("input");
    startInput.type = "text";
    startInput.placeholder = "Seconds or mm:ss";
    startInput.value = clip.startText ?? String(clip.start);
    startInput.addEventListener("change", () => {
      const value = parseTime(startInput.value);
      if (Number.isFinite(value)) {
        clip.start = value;
        clip.startText = startInput.value;
        validateClipCard(card, clip);
      } else {
        card.classList.add("invalid");
      }
      updateRenderButton();
    });
    startLabel.appendChild(startInput);

    const endLabel = document.createElement("label");
    endLabel.className = "field";
    endLabel.textContent = "End time";

    const endInput = document.createElement("input");
    endInput.type = "text";
    endInput.placeholder = "Seconds or mm:ss";
    endInput.value = clip.endText ?? String(clip.end);
    endInput.addEventListener("change", () => {
      const value = parseTime(endInput.value);
      if (Number.isFinite(value)) {
        clip.end = value;
        clip.endText = endInput.value;
        validateClipCard(card, clip);
      } else {
        card.classList.add("invalid");
      }
      updateRenderButton();
    });
    endLabel.appendChild(endInput);

    fields.append(startLabel, endLabel);

    const duration = document.createElement("p");
    duration.className = "status-message";
    duration.textContent = `Length: ${Math.max(0, clip.end - clip.start).toFixed(1)} seconds`;

    card.append(heading, fields, duration);
    list.appendChild(card);
    validateClipCard(card, clip);
  });

  updateRenderButton();
}

function validateClipCard(card, clip) {
  const valid =
    Number.isFinite(clip.start) &&
    Number.isFinite(clip.end) &&
    clip.start >= 0 &&
    clip.end > clip.start &&
    clip.end <= state.duration;

  card.classList.toggle("invalid", !valid);
  return valid;
}

function updateRenderButton() {
  const selected = state.clips.filter(clip => clip.selected !== false);
  const valid = selected.length > 0 && selected.every(clip =>
    Number.isFinite(clip.start) &&
    Number.isFinite(clip.end) &&
    clip.start >= 0 &&
    clip.end > clip.start &&
    clip.end <= state.duration
  );

  $("renderClips").disabled = state.busy || !valid;
}

function addClip(start, end, selected = true) {
  state.clips.push({ start, end, selected });
}

function createSuggestedClips() {
  if (!state.uploadId || state.duration <= 0) return;

  const target = getRequestedDuration();
  const cuts = [0, ...state.sceneChanges, state.duration];
  const suggestions = [];

  let start = 0;

  while (start < state.duration && suggestions.length < 20) {
    let end = Math.min(start + target, state.duration);

    const nearby = cuts.find(time =>
      time > start + target * 0.65 &&
      time < start + target * 1.25 &&
      time < state.duration
    );

    if (nearby) end = nearby;

    if (end - start >= 5) {
      suggestions.push({ start, end, selected: true });
    }

    start = end;
  }

  state.clips = suggestions;
  renderClipList();

  setStatus(
    "sceneNotice",
    `Suggested ${suggestions.length} clips. Review the times before rendering.`
  );
}

async function uploadVideo() {
  const file = $("videoFile").files[0];

  if (!file) {
    setStatus("uploadStatus", "Choose a video first.", true);
    return;
  }

  if (!file.type.startsWith("video/")) {
    setStatus("uploadStatus", "Please select a video file.", true);
    return;
  }

  const formData = new FormData();
  formData.append("video", file);

  state.busy = true;
  $("uploadVideo").disabled = true;
  $("scanScenes").disabled = true;
  setStatus("uploadStatus", "Uploading video…");

  try {
    const response = await fetch("/api/clipper/upload", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Upload failed.");
    }

    state.uploadId = data.uploadId;
    state.duration = data.duration;
    state.sceneChanges = [];
    state.clips = [];

    $("videoDuration").textContent =
      `${formatTime(data.duration)} (${data.duration.toFixed(1)} seconds)`;

    show($("videoInfo"));
    show($("clipsSection"));
    show($("resultsSection"), false);

    setStatus("uploadStatus", `Uploaded: ${data.filename}`);
    setStatus("sceneNotice", "");
    $("scanScenes").disabled = false;
    renderClipList();
  } catch (error) {
    setStatus("uploadStatus", error.message, true);
  } finally {
    state.busy = false;
    $("uploadVideo").disabled = false;
    updateRenderButton();
  }
}

async function scanScenes() {
  if (!state.uploadId) {
    setStatus("uploadStatus", "Upload a video first.", true);
    return;
  }

  state.busy = true;
  $("scanScenes").disabled = true;
  $("autoSelectClips").disabled = true;
  setStatus("uploadStatus", "Detecting visual scene changes. This may take a while…");

  try {
    const response = await fetch("/api/clipper/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: state.uploadId })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Scene detection failed.");
    }

    state.sceneChanges = data.sceneChanges || [];
    setStatus(
      "uploadStatus",
      `Detection finished. Found ${state.sceneChanges.length} visual changes.`
    );
    setStatus(
      "sceneNotice",
      "These are visual-change suggestions, not AI-selected viral moments."
    );
  } catch (error) {
    setStatus("uploadStatus", error.message, true);
  } finally {
    state.busy = false;
    $("scanScenes").disabled = !state.uploadId;
    $("autoSelectClips").disabled = false;
  }
}

function addManualClip() {
  if (!state.uploadId) {
    setStatus("uploadStatus", "Upload a video first.", true);
    return;
  }

  const duration = Math.min(getRequestedDuration(), state.duration);
  const start = state.clips.length
    ? Math.min(state.clips[state.clips.length - 1].end, Math.max(0, state.duration - duration))
    : 0;

  addClip(start, Math.min(start + duration, state.duration));
  renderClipList();
}

async function renderClips() {
  const selected = state.clips
    .filter(clip => clip.selected !== false)
    .map(clip => ({ start: clip.start, end: clip.end }));

  if (!state.uploadId || selected.length === 0) {
    setStatus("renderStatus", "Select at least one valid clip.", true);
    return;
  }

  state.busy = true;
  $("renderClips").disabled = true;
  setStatus("renderStatus", `Rendering ${selected.length} clip(s)… Please keep this page open.`);

  try {
    const response = await fetch("/api/clipper/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploadId: state.uploadId,
        clips: selected,
        format: $("videoFormat").value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Rendering failed.");
    }

    const list = $("resultsList");
    list.innerHTML = "";

    for (const clip of data.clips || []) {
      const card = document.createElement("article");
      card.className = "result-card";

      const title = document.createElement("h3");
      title.textContent = clip.filename;

      const video = document.createElement("video");
      video.controls = true;
      video.playsInline = true;
      video.src = clip.url;

      const link = document.createElement("a");
      link.className = "primary-button";
      link.href = clip.url;
      link.download = clip.filename;
      link.textContent = "Download clip";

      card.append(title, video, link);
      list.appendChild(card);
    }

    show($("resultsSection"));
    setStatus("renderStatus", `Finished. ${data.clips.length} clip(s) ready.`);
  } catch (error) {
    setStatus("renderStatus", error.message, true);
  } finally {
    state.busy = false;
    updateRenderButton();
  }
}

function setupUI() {
  $("menuToggle").addEventListener("click", () => {
    show($("mainMenu"), $("mainMenu").classList.contains("hidden"));
  });

  $("videoFile").addEventListener("change", () => {
    const file = $("videoFile").files[0];
    $("selectedVideoName").textContent = file
      ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`
      : "";
  });

  $("uploadVideo").addEventListener("click", uploadVideo);
  $("scanScenes").addEventListener("click", scanScenes);
  $("autoSelectClips").addEventListener("click", createSuggestedClips);
  $("addManualClip").addEventListener("click", addManualClip);
  $("renderClips").addEventListener("click", renderClips);

  $("clipDuration").addEventListener("change", () => {
    show($("customDurationBox"), $("clipDuration").value === "custom");
  });
}

document.addEventListener("DOMContentLoaded", setupUI);
