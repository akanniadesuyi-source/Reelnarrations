const $ = id => document.getElementById(id);

const state = {
  jobId: null,
  pollTimer: null,
  scenes: [],
  script: "",
  geminiKey: ""
};

const keyInput = $("geminiApiKey");
const keyStatus = $("apiKeyStatus");
const videoInput = $("movieVideo");
const manualScenes = $("manualScenes");
const sceneList = $("sceneList");
const createButton = $("createShort");
const progressSection = $("progressSection");
const progressBar = $("progressBar");
const progressPercent = $("progressPercent");
const progressMessage = $("progressMessage");
const createStatus = $("createStatus");
const scriptSection = $("scriptSection");
const resultSection = $("resultSection");

function show(element, visible = true) {
  if (element) element.classList.toggle("hidden", !visible);
}

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message || "";
  element.classList.toggle("error", Boolean(isError));
}

function setProgress(percent, message) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  progressBar.style.width = `${value}%`;
  progressPercent.textContent = `${Math.round(value)}%`;
  progressMessage.textContent = message || "Working...";
  show(progressSection);
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remaining = value % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function parseTime(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;

  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const parts = text.split(":").map(Number);
  if (parts.some(part => !Number.isFinite(part))) return NaN;

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return NaN;
}

function addSceneRow(scene = {}) {
  const row = document.createElement("div");
  row.className = "scene-row";

  const start = document.createElement("input");
  start.type = "text";
  start.placeholder = "Start (e.g. 00:12)";
  start.value = scene.startText || formatTime(scene.start || 0);
  start.setAttribute("aria-label", "Scene start time");

  const end = document.createElement("input");
  end.type = "text";
  end.placeholder = "End (e.g. 00:20)";
  end.value = scene.endText || formatTime(scene.end || 0);
  end.setAttribute("aria-label", "Scene end time");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text-button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    row.remove();
    updateSceneNumbers();
  });

  row.append(start, end, remove);
  row.dataset.scene = "true";
  sceneList.appendChild(row);
  updateSceneNumbers();
}

function updateSceneNumbers() {
  [...sceneList.querySelectorAll(".scene-row")].forEach((row, index) => {
    row.dataset.number = String(index + 1);
  });
}

function collectManualScenes() {
  const rows = [...sceneList.querySelectorAll(".scene-row")];

  if (rows.length < 2 || rows.length > 6) {
    throw new Error("Add between 2 and 6 scenes.");
  }

  const clips = rows.map((row, index) => {
    const inputs = row.querySelectorAll("input");
    const start = parseTime(inputs[0].value);
    const end = parseTime(inputs[1].value);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`Check the timestamps for scene ${index + 1}.`);
    }

    return {
      start,
      end,
      reason: "Manually selected scene"
    };
  });

  clips.sort((a, b) => a.start - b.start);

  const total = clips.reduce((sum, clip) => sum + clip.end - clip.start, 0);
  if (total < 10 || total > 90) {
    throw new Error("Selected scenes must total between 10 and 90 seconds.");
  }

  return clips;
}

function getSavedKey() {
  try {
    return localStorage.getItem("reelnarrator_gemini_key") || "";
  } catch {
    return "";
  }
}

function saveGeminiKey() {
  const key = keyInput.value.trim();

  if (!key) {
    setStatus(keyStatus, "Paste your Gemini API key first.", true);
    return;
  }

  state.geminiKey = key;

  if ($("rememberGeminiKey").checked) {
    try {
      localStorage.setItem("reelnarrator_gemini_key", key);
      setStatus(keyStatus, "Key saved on this device.");
    } catch {
      setStatus(keyStatus, "Could not save locally. The key will be used for this session.");
    }
  } else {
    try {
      localStorage.removeItem("reelnarrator_gemini_key");
    } catch {}
    setStatus(keyStatus, "Key loaded for this session only.");
  }
}

function clearGeminiKey() {
  state.geminiKey = "";
  keyInput.value = "";
  try {
    localStorage.removeItem("reelnarrator_gemini_key");
  } catch {}
  setStatus(keyStatus, "Gemini key cleared from this device.");
}

function getSettings() {
  return {
    format: $("videoFormat").value,
    targetDuration: Number($("targetDuration").value),
    recapStyle: $("recapStyle").value,
    voiceType: $("voiceType").value,
    voiceAccent: $("voiceAccent").value,
    voiceSpeed: $("voiceSpeed").value,
    scriptInstructions: $("scriptInstructions").value.trim(),
    includeCaptions: $("includeCaptions").checked,
    captionPosition: $("captionPosition").value,
    captionSize: $("captionSize").value,
    captionColor: $("captionColor").value
  };
}

function showScript(narration, clips = []) {
  state.script = narration || "";
  state.scenes = clips || [];

  $("fullNarration").value = state.script;
  const sceneScriptList = $("sceneScriptList");
  sceneScriptList.innerHTML = "";

  state.scenes.forEach((clip, index) => {
    const card = document.createElement("div");
    card.className = "scene-script-card";

    const heading = document.createElement("h3");
    heading.textContent = `Scene ${index + 1} · ${formatTime(clip.start)}–${formatTime(clip.end)}`;

    const description = document.createElement("p");
    description.textContent = clip.description || clip.reason || "Selected scene";

    card.append(heading, description);
    sceneScriptList.appendChild(card);
  });

  show(scriptSection);
  scriptSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function createRecap() {
  setStatus(createStatus, "");
  show(resultSection, false);
  show(scriptSection, false);

  if (!videoInput.files || !videoInput.files[0]) {
    setStatus(createStatus, "Choose a video first.", true);
    return;
  }

  if (!keyInput.value.trim() && !state.geminiKey) {
    setStatus(createStatus, "Add your Gemini API key in API Settings first.", true);
    $("settingsSection").scrollIntoView({ behavior: "smooth" });
    return;
  }

  let manualClips = [];

  if ($("sceneMode").value === "manual") {
    try {
      manualClips = collectManualScenes();
    } catch (error) {
      setStatus(createStatus, error.message, true);
      return;
    }
  }

  const formData = new FormData();
  formData.append("movie", videoInput.files[0]);
  formData.append("mode", $("sceneMode").value);
  formData.append("manualClips", JSON.stringify(manualClips));
  formData.append("settings", JSON.stringify(getSettings()));
  formData.append("geminiApiKey", keyInput.value.trim() || state.geminiKey);

  createButton.disabled = true;
  createButton.textContent = "Starting...";
  setProgress(2, "Uploading video...");

  try {
    const response = await fetch("/api/create-short", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Could not start the recap.");
    }

    state.jobId = data.id;
    await pollJob();
  } catch (error) {
    setStatus(createStatus, error.message || "Something went wrong.", true);
    show(progressSection, false);
  } finally {
    createButton.disabled = false;
    createButton.textContent = "Create recap";
  }
}

async function pollJob() {
  if (!state.jobId) return;

  try {
    const response = await fetch(`/api/jobs/${state.jobId}`, {
      cache: "no-store"
    });
    const job = await response.json();

    if (!response.ok) {
      throw new Error(job.error || "Could not check job status.");
    }

    setProgress(job.progress, job.message);

    if (job.stage === "error") {
      throw new Error(job.error || job.message || "Recap failed.");
    }

    if (job.stage === "script_ready" || job.stage === "review") {
      showScript(job.result?.narration || "", job.result?.clips || []);
      setStatus(createStatus, "Review the narration below.");
      return;
    }

    if (job.stage === "ready") {
      const videoUrl = job.result?.videoUrl;
      const downloadUrl = job.result?.downloadUrl;

      if (videoUrl) $("resultVideo").src = videoUrl;
      if (downloadUrl) $("downloadVideo").href = downloadUrl;

      if (job.result?.narration) {
        $("fullNarration").value = job.result.narration;
      }

      show(resultSection);
      setStatus(createStatus, "Your recap is ready.");
      resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    setTimeout(pollJob, 1800);
  } catch (error) {
    setStatus(createStatus, error.message || "Job status check failed.", true);
    show(progressSection, false);
  }
}

async function generateFinalVideo() {
  if (!state.jobId) {
    setStatus(createStatus, "Create a recap first.", true);
    return;
  }

  const narration = $("fullNarration").value.trim();

  if (narration.length < 20) {
    setStatus(createStatus, "Please review or enter a longer narration.", true);
    return;
  }

  setStatus(createStatus, "Submitting reviewed narration...");

  try {
    const response = await fetch(`/api/jobs/${state.jobId}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        narration,
        settings: getSettings(),
        geminiApiKey: keyInput.value.trim() || state.geminiKey
      })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Could not generate the final video.");
    }

    setStatus(createStatus, "Generating voice and video...");
    pollJob();
  } catch (error) {
    setStatus(createStatus, error.message || "Final generation failed.", true);
  }
}

async function regenerateScript() {
  if (!state.jobId) {
    setStatus(createStatus, "Create a recap first.", true);
    return;
  }

  setStatus(createStatus, "Regenerating narration...");

  try {
    const response = await fetch(`/api/jobs/${state.jobId}/regenerate-script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: getSettings(),
        geminiApiKey: keyInput.value.trim() || state.geminiKey
      })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Could not regenerate narration.");
    }

    setStatus(createStatus, "New narration is ready to review.");
    showScript(data.narration, data.clips || state.scenes);
  } catch (error) {
    setStatus(createStatus, error.message || "Script regeneration failed.", true);
  }
}

function setupMenu() {
  const toggle = $("menuToggle");
  const menu = $("mainMenu");

  toggle.addEventListener("click", () => {
    const isOpen = !menu.classList.contains("hidden");
    show(menu, !isOpen);
    toggle.setAttribute("aria-expanded", String(!isOpen));
  });

  menu.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => {
      show(menu, false);
      toggle.setAttribute("aria-expanded", "false");
    });
  });
}

function setupUI() {
  setupMenu();

  keyInput.value = getSavedKey();
  state.geminiKey = keyInput.value;

  if (state.geminiKey) {
    setStatus(keyStatus, "Saved Gemini key loaded.");
  }

  $("toggleGeminiKey").addEventListener("click", () => {
    const showKey = keyInput.type === "password";
    keyInput.type = showKey ? "text" : "password";
    $("toggleGeminiKey").textContent = showKey ? "Hide" : "Show";
  });

  $("saveGeminiKey").addEventListener("click", saveGeminiKey);
  $("clearGeminiKey").addEventListener("click", clearGeminiKey);

  videoInput.addEventListener("change", () => {
    const file = videoInput.files?.[0];
    $("selectedVideoName").textContent = file
      ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`
      : "";
  });

  $("sceneMode").addEventListener("change", () => {
    const manual = $("sceneMode").value === "manual";
    show(manualScenes, manual);

    if (manual && sceneList.children.length === 0) {
      addSceneRow();
      addSceneRow();
    }
  });

  $("addScene").addEventListener("click", () => {
    if (sceneList.children.length >= 6) {
      setStatus(createStatus, "You can add up to 6 scenes.", true);
      return;
    }
    addSceneRow();
  });

  $("includeCaptions").addEventListener("change", () => {
    show($("captionSettings"), $("includeCaptions").checked);
  });

  createButton.addEventListener("click", createRecap);
  $("generateFinalVideo").addEventListener("click", generateFinalVideo);
  $("regenerateScript").addEventListener("click", regenerateScript);

  show($("captionSettings"), $("includeCaptions").checked);
}

document.addEventListener("DOMContentLoaded", setupUI);
