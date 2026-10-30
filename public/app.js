const $ = (id) => document.getElementById(id);

let activeTab = "upload";

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach(b =>
      b.classList.toggle("active", b === btn)
    );
    $("uploadPane").classList.toggle("hidden", activeTab !== "upload");
    $("youtubePane").classList.toggle("hidden", activeTab !== "youtube");
    $("status").textContent = "";
  });
});

$("movieFile").addEventListener("change", () => {
  $("fileName").textContent =
    $("movieFile").files[0]?.name || "No file selected";
});

function busy(button, on, label) {
  button.disabled = on;
  button.textContent = on ? "Working..." : label;
}

async function showError(response) {
  const data = await response.json().catch(() => ({}));
  throw new Error(data.error || "Something went wrong.");
}

async function makeNarration(url, file) {
  const button = file ? $("uploadBtn") : $("youtubeBtn");
  const original = file
    ? "Analyse movie & create script"
    : "Analyse link & create script";

  busy(button, true, original);
  $("status").textContent = "Analysing the video. This can take a while...";

  try {
    let response;

    if (file) {
      const form = new FormData();
      form.append("movie", file);
      response = await fetch("/api/narrate-upload", {
        method: "POST",
        body: form
      });
    } else {
      response = await fetch("/api/narrate-youtube", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({url})
      });
    }

    if (!response.ok) await showError(response);

    const data = await response.json();
    $("script").value = data.script || "";
    $("status").textContent =
      "Your narration script is ready. Review it before generating the voice.";
  } catch (err) {
    $("status").textContent = err.message;
  } finally {
    busy(button, false, original);
  }
}

$("uploadBtn").addEventListener("click", () => {
  const file = $("movieFile").files[0];

  if (!file) {
    $("status").textContent = "Choose a video file first.";
    return;
  }

  makeNarration("", file);
});

$("youtubeBtn").addEventListener("click", () => {
  const url = $("youtubeUrl").value.trim();

  if (!url) {
    $("status").textContent = "Paste a YouTube link first.";
    return;
  }

  makeNarration(url, null);
});

$("copyBtn").addEventListener("click", async () => {
  if (!$("script").value.trim()) {
    $("status").textContent = "There is no script to copy yet.";
    return;
  }

  try {
    await navigator.clipboard.writeText($("script").value);
    $("status").textContent = "Script copied.";
  } catch {
    $("status").textContent = "Select the script and copy it manually.";
  }
});

$("voiceBtn").addEventListener("click", async () => {
  const text = $("script").value.trim();

  if (!text) {
    $("status").textContent = "Generate or paste a script first.";
    return;
  }

  const btn = $("voiceBtn");
  busy(btn, true, "Generate voice");
  $("status").textContent = "Generating voice...";
  $("audio").classList.add("hidden");
  $("downloadAudio").classList.add("hidden");

  try {
    const response = await fetch("/api/voice", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({text})
    });

    if (!response.ok) await showError(response);

    const blob = await response.blob();
    const audioUrl = URL.createObjectURL(blob);

    $("audio").src = audioUrl;
    $("audio").classList.remove("hidden");
    $("downloadAudio").href = audioUrl;
    $("downloadAudio").classList.remove("hidden");

    $("status").textContent = "Voice generated. Listen or download it.";
  } catch (err) {
    $("status").textContent = err.message;
  } finally {
    busy(btn, false, "Generate voice");
  }
});
