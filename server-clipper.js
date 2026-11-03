import express from "express";
import multer from "multer";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(process.cwd(), "public");
const WORK_DIR = path.join(os.tmpdir(), "reelnarrator-clipper");
const UPLOAD_DIR = path.join(WORK_DIR, "uploads");
const OUTPUT_DIR = path.join(WORK_DIR, "outputs");

for (const dir of [WORK_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});

const videos = new Map();
const outputs = new Map();

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      reject(new Error(`${command} could not start: ${error.message}`));
    });

    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.slice(-3000) || `${command} exited with code ${code}`));
    });
  });
}

async function getVideoInfo(file) {
  const { stdout } = await runCommand(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file
  ]);

  const duration = Number(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not read this video's duration.");
  }

  return duration;
}

function makeId() {
  return crypto.randomUUID();
}

function formatFilter(format) {
  if (format === "16:9") {
    return "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080";
  }

  if (format === "1:1") {
    return "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080";
  }

  return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
}

app.get("/api/clipper/health", (req, res) => {
  res.json({ ok: true, service: "clipper" });
});

app.post("/api/clipper/upload", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Choose a video first." });
  }

  try {
    const duration = await getVideoInfo(req.file.path);
    const id = makeId();

    videos.set(id, {
      id,
      path: req.file.path,
      originalName: req.file.originalname,
      duration,
      createdAt: Date.now()
    });

    res.json({
      uploadId: id,
      filename: req.file.originalname,
      duration
    });
  } catch (error) {
    fs.rmSync(req.file.path, { force: true });
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/clipper/scan", async (req, res) => {
  const video = videos.get(String(req.body.uploadId || ""));

  if (!video) {
    return res.status(404).json({ error: "Upload not found. Please upload again." });
  }

  try {
    const { stderr } = await runCommand(FFMPEG, [
      "-hide_banner",
      "-i", video.path,
      "-vf", "select='gt(scene,0.35)',showinfo",
      "-an",
      "-f", "null",
      "-"
    ]);

    const timestamps = [];
    const regex = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
    let match;

    while ((match = regex.exec(stderr)) !== null) {
      const time = Number(match[1]);
      if (time > 1 && time < video.duration - 1) {
        timestamps.push(time);
      }
    }

    const unique = [...new Set(timestamps)]
      .sort((a, b) => a - b)
      .filter((time, index, arr) => index === 0 || time - arr[index - 1] >= 2);

    res.json({
      duration: video.duration,
      sceneChanges: unique,
      note: "Scene detection identifies visual changes, not guaranteed viral moments."
    });
  } catch (error) {
    res.status(500).json({
      error: "Scene detection failed.",
      details: error.message.slice(0, 500)
    });
  }
});

app.post("/api/clipper/render", async (req, res) => {
  const video = videos.get(String(req.body.uploadId || ""));
  const clips = req.body.clips;
  const format = ["9:16", "16:9", "1:1"].includes(req.body.format)
    ? req.body.format
    : "9:16";

  if (!video) {
    return res.status(404).json({ error: "Upload not found. Please upload again." });
  }

  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 20) {
    return res.status(400).json({ error: "Select between 1 and 20 clips." });
  }

  const normalized = [];

  for (const clip of clips) {
    const start = Number(clip.start);
    const end = Number(clip.end);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > video.duration ||
      end - start > 300
    ) {
      return res.status(400).json({
        error: "Each clip needs valid start/end times and must be 5 minutes or less."
      });
    }

    normalized.push({ start, end });
  }

  try {
    const rendered = [];

    for (let i = 0; i < normalized.length; i++) {
      const clip = normalized[i];
      const outputId = makeId();
      const outputFile = path.join(OUTPUT_DIR, `${outputId}.mp4`);

      await runCommand(FFMPEG, [
        "-hide_banner",
        "-y",
        "-ss", String(clip.start),
        "-i", video.path,
        "-t", String(clip.end - clip.start),
        "-vf", formatFilter(format),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputFile
      ]);

      outputs.set(outputId, {
        path: outputFile,
        filename: `clip-${i + 1}.mp4`,
        createdAt: Date.now()
      });

      rendered.push({
        id: outputId,
        filename: `clip-${i + 1}.mp4`,
        url: `/api/clipper/output/${outputId}`
      });
    }

    res.json({ clips: rendered });
  } catch (error) {
    res.status(500).json({
      error: "Rendering failed.",
      details: error.message.slice(-1000)
    });
  }
});

app.get("/api/clipper/output/:id", (req, res) => {
  const output = outputs.get(req.params.id);

  if (!output || !fs.existsSync(output.path)) {
    return res.status(404).send("Clip not found.");
  }

  res.download(output.path, output.filename);
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "Video is larger than the 500 MB upload limit."
        : error.message
    });
  }

  res.status(500).json({ error: error.message || "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`ReelNarrator clipper listening on port ${PORT}`);
});
