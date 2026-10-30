const $ = (id) => document.getElementById(id);

let activeTab = "upload";
let currentVideoUrl = null;

function setStatus(message, error = false) {
  $("status").textContent = message;
  $("status").style.color = error ? "#ff8585" : "#63d6a3";
}

function busy(button, on, label) {
  button.disabled = on;
  button.textContent = on ? "Creating your Short..." : label;
}

// Switch between upload and YouTube tabs.
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;

    document.querySelectorAll(".tab").forEach(tab =>
      tab.classList.toggle("active", tab === btn)
    );

    $("uploadPane").classList.toggle("hidden", activeTab !== "upload");
    $("youtubePane").classList.toggle("hidden", activeTab !== "youtube");

    setStatus("");
  });
});

// Display selected filename.
$("movieFile").addEventListener("change", () => {
  const file = $("movieFile").files[0];

  $("fileName").textContent = file
    ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`
    : "No file selected";
});

// Create preview area.
const preview = document.createElement("section");
preview.id = "shortPreview";
preview.className = "panel hidden";
preview.innerHTML = `
  <div class="sectionHead">
    <div>
      <p class="eyebrow">YOUR FINISHED VIDEO</p>
      <h2 id="shortTitle">Your YouTube Short</h2>
    </div>
  </div>
  <video id="shortVideo" controls playsinline
    style="width:100%;max-height:600px;background:#000;border-radius:12px">
  </video>
  <div id="clipDetails" style="margin-top:18px"></div>
  <a id="shortDownload" class="primary"
    style="display:block;text-align:center;text-decoration:none;margin-top:18px"
    download="reelnarrator-short.mp4">
    Download finished Short
  </a>
`;

$("status").parentNode.insertBefore(
  preview,
  $("status").parentNode.nextSibling
);

// Create a Short using the new backend.
function createShort(file) {
  if (!file) {
    setStatus("Choose a video first.", true);
    return;
  }

  if (!file.type.startsWith("video/")) {
    setStatus("Please select a video file.", true);
    return;
  }

  const button = $("uploadBtn");
  const originalLabel = "Analyse movie & create script";

  busy(button, true, originalLabel);
  preview.classList.add("hidden");

  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }

  setStatus("Uploading your video...");

  const form = new FormData();
  form.append("movie", file);

  const request = new XMLHttpRequest();

  request.open("POST", "/api/create-short");

  request.upload.onprogress = event => {
    if (event.lengthComputable) {
      const percent = Math.round(
        event.loaded / event.total * 100
      );
      setStatus(`Uploading video: ${percent}%`);
    }
  };

  request.onload = () => {
    busy(button, false, originalLabel);

    let data;

    try {
      data = JSON.parse(request.responseText);
    } catch {
      setStatus("The server returned an unreadable response.", true);
      return;
    }

    if (request.status < 200 || request.status >= 300) {
      setStatus(data.error || "Could not create your Short.", true);
      return;
    }

    $("shortTitle").textContent =
      data.title || "Your YouTube Short";

    $("shortVideo").src = data.downloadUrl;
    $("shortDownload").href = data.downloadUrl;

    $("clipDetails").innerHTML = "";

    const heading = document.createElement("h3");
    heading.textContent = "Selected moments";
    heading.style.marginBottom = "12px";
    $("clipDetails").appendChild(heading);

    (data.clips || []).forEach((clip, index) => {
      const item = document.createElement("p");
      item.style.padding = "10px 0";
      item.style.borderBottom = "1px solid #282f40";

      const start = Number(clip.start).toFixed(1);
      const end = Number(clip.end).toFixed(1);

      item.textContent =
        `${index + 1}. ${start}s – ${end}s: ${clip.reason}`;

      $("clipDetails").appendChild(item);
    });

    preview.classList.remove("hidden");
    setStatus("Your Short is ready! Preview it below.");
    preview.scrollIntoView({ behavior: "smooth" });
  };

  request.onerror = () => {
    busy(button, false, originalLabel);
    setStatus("Connection failed. Please try again.", true);
  };

  request.onabort = () => {
    busy(button, false, originalLabel);
    setStatus("Upload was cancelled.", true);
  };

  request.onloadstart = () => {
    setStatus("Uploading and preparing your video...");
  };

  request.send(form);
}

$("uploadBtn").addEventListener("click", () => {
  createShort($("movieFile").files[0]);
});

// Copy script.
$("copyBtn").addEventListener("click", async () => {
  const script = $("script").value.trim();

  if (!script) {
    setStatus("There is no script to copy yet.", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(script);
    setStatus("Script copied.");
  } catch {
    setStatus("Select the script and copy it manually.");
  }
});

// Keep voice generation available.
$("voiceBtn").addEventListener("click", async () => {
  const text = $("script").value.trim();

  if (!text) {
    setStatus("Write a narration first.", true);
    return;
  }

  const button = $("voiceBtn");
  busy(button, true, "Generate voice");

  try {
    setStatus("Generating voice...");

    const response = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Voice generation failed.");
    }

    const blob = await response.blob();
    const audioUrl = URL.createObjectURL(blob);

    $("audio").src = audioUrl;
    $("audio").classList.remove("hidden");

    $("downloadAudio").href = audioUrl;
    $("downloadAudio").classList.remove("hidden");

    setStatus("Voice generated successfully.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    busy(button, false, "Generate voice");
  }
});
      
