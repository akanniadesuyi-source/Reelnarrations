
import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000;

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.8-flash";
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

app.use(express.json());
app.use(express.static("public"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, callback) {
    if (!file.mimetype.startsWith("video/")) {
      return callback(new Error("Please upload a video file."));
    }
    callback(null, true);
  }
});

const jobs = new Map();

function updateJob(id, values) {
  const job = jobs.get(id);
  if (!job) return;

  Object.assign(job, values, {
    updatedAt: Date.now()
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorDetails(error) {
  const status =
    error?.status ??
    error?.code ??
    error?.response?.status ??
    error?.error?.code;

  const message = [
    error?.message,
    error?.statusText,
    error?.response?.statusText,
    error?.error?.message
  ].filter(Boolean).join(" ");

  return {
    status: String(status ?? ""),
    message: message.toLowerCase()
  };
}

function isRetryableGeminiError(error) {
  const { status, message } = getErrorDetails(error);

  if (
    ["429", "500", "502", "503", "504"].includes(status) ||
    ["UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL", "DEADLINE_EXCEEDED"]
      .some((code) => message.includes(code.toLowerCase()))
  ) {
    return true;
  }

  return (
    message.includes("high demand") ||
    message.includes("temporarily unavailable") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("network")
  );
}

async function generateContentWithRetry(request, jobId) {
  const maxAttempts = 4;
  const waitTimes = [2000, 5000, 10000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      // Log the original Gemini error.
      console.error("GEMINI RAW ERROR:", {
        name: error?.name,
        status:
          error?.status ??
          error?.code ??
          error?.response?.status ??
          error?.error?.code,
        message: error?.message,
        details: error?.error
      });

      const canRetry =
        attempt < maxAttempts && isRetryableGeminiError(error);

      if (!canRetry) {
        throw new Error(
          `Gemini request failed: ${
            error?.message || "Unknown Gemini error"
          }`
        );
      }

      const waitMs = waitTimes[attempt - 1];
      const waitSeconds = Math.ceil(waitMs / 1000);

      console.warn(
        `Gemini temporary error on attempt ${attempt}/${maxAttempts}. Retrying in ${waitSeconds}s.`
      );

      updateJob(jobId, {
        stage: "analysing",
        progress: 42,
        message: `Gemini is busy. Retrying analysis (${attempt + 1} of ${maxAttempts}) in ${waitSeconds} seconds...`
      });

      await sleep(waitMs);
    }
  }

  throw new Error("Gemini analysis could not be completed.");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let errorOutput = "";

    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`Video processing failed. ${errorOutput.slice(-1200)}`)
        );
      }
    });
  });
}

function parseAIResponse(response) {
  const text =
    typeof response.text === "function"
      ? response.text()
      : response.text;

  if (!text) {
    throw new Error("Gemini returned an empty analysis.");
  }

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("Gemini did not return valid JSON.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateClips(clips) {
  if (!Array.isArray(clips) || clips.length < 2) {
    throw new Error("AI could not find enough useful scenes.");
  }

  const valid = clips.map((clip) => ({
    start: Number(clip.start),
    end: Number(clip.end),
    reason: String(clip.reason || "Selected scene")
  }));

  for (const clip of valid) {
    if (
      !Number.isFinite(clip.start) ||
      !Number.isFinite(clip.end) ||
      clip.start < 0 ||
      clip.end <= clip.start ||
      clip.end - clip.start < 2 ||
      clip.end - clip.start > 25
    ) {
      throw new Error("AI returned invalid scene timestamps.");
    }
  }

  valid.sort((a, b) => a.start - b.start);

  const total = valid.reduce(
    (sum, clip) => sum + clip.end - clip.start,
    0
  );

  if (total < 10 || total > 90) {
    throw new Error("AI selected an unsuitable total video length.");
  }

  return valid;
}

async function analyseVideo(filePath, mimeType, jobId) {
  updateJob(jobId, {
    stage: "analysing",
    progress: 15,
    message: "Uploading video to Gemini for analysis..."
  });

  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType }
  });

  if (!uploaded.name) {
    throw new Error("Gemini did not provide a video file reference.");
  }

  let file = uploaded;
  const startedAt = Date.now();
  const maxWait = 5 * 60 * 1000;

  while (true) {
    const state = String(file.state || "").toUpperCase();

    if (state.includes("ACTIVE")) break;

    if (state.includes("FAILED")) {
      throw new Error("Gemini could not process the uploaded video.");
    }

    if (Date.now() - startedAt > maxWait) {
      throw new Error(
        `Gemini video processing timed out. Last state: ${state || "UNKNOWN"}`
      );
    }

    const elapsed = Date.now() - startedAt;
    const progress = Math.min(35, 18 + Math.floor(elapsed / 15000));

    updateJob(jobId, {
      progress,
      message: `Gemini is preparing the video. Status: ${state || "PROCESSING"}`
    });

    await sleep(5000);
    file = await ai.files.get({ name: uploaded.name });
  }

  updateJob(jobId, {
    progress: 38,
    message: "Video ready. AI is finding the strongest scenes..."
  });

  const prompt = `
You are an expert movie and video editor.

Analyse the supplied video and select the strongest scenes for a short,
coherent video recap.

Rules:
- Select 2 to 6 scenes.
- Keep scenes in chronological order.
- Do not invent scenes or events.
- Choose moments that make sense when watched together.
- Avoid unnecessary repeated footage.
- Each scene should be between 3 and 15 seconds.
- Aim for a total duration between 20 and 55 seconds.
- Timestamps must refer to the original video.
- Clips must not extend beyond the supplied video.

Return ONLY valid JSON in this exact structure:

{
  "clips": [
    {
      "start": 10.0,
      "end": 18.0,
      "reason": "A short explanation of why this moment matters"
    }
  ]
}
`;

  updateJob(jobId, {
    progress: 42,
    message: "AI is analysing the scenes and choosing clips..."
  });

  const response = await generateContentWithRetry(
    {
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: file.uri,
                mimeType: file.mimeType || mimeType
              }
            },
            { text: prompt }
          ]
        }
      ]
    },
    jobId
  );

  const result = parseAIResponse(response);
  return { clips: validateClips(result.clips) };
}

async function renderShort(inputPath, clips, outputPath, jobId) {
  const directory = path.dirname(outputPath);
  const clipFiles = [];

  updateJob(jobId, {
    stage: "rendering",
    progress: 65,
    message: "Preparing selected scenes for rendering..."
  });

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const clipPath = path.join(directory, `clip-${i}.mp4`);
    const duration = clip.end - clip.start;

    updateJob(jobId, {
      progress: 65 + Math.floor((i / clips.length) * 20),
      message: `Rendering selected scene ${i + 1} of ${clips.length}...`
    });

    await runCommand(ffmpegPath, [
      "-y",
      "-ss", String(clip.start),
      "-i", inputPath,
      "-t", String(duration),
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "26",
      "-an",
      "-movflags", "+faststart",
      clipPath
    ]);

    clipFiles.push(clipPath);
  }

  updateJob(jobId, {
    progress: 87,
    message: "Joining selected scenes into your finished video..."
  });

  const listPath = path.join(directory, "clips.txt");
  const listContents = clipFiles
    .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
    .join("\n");

  fs.writeFileSync(listPath, listContents);

  await runCommand(ffmpegPath, [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath
  ]);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
    throw new Error("The finished video file could not be created.");
  }
}

async function processVideo(jobId, buffer, mimeType) {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "reelnarrator-")
  );

  const inputPath = path.join(directory, "original-video.mp4");
  const outputPath = path.join(directory, "finished-short.mp4");

  const job = jobs.get(jobId);
  if (job) job.directory = directory;

  try {
    updateJob(jobId, {
      stage: "saving",
      progress: 10,
      message: "Saving uploaded video..."
    });

    await fs.promises.writeFile(inputPath, buffer);

    updateJob(jobId, {
      progress: 12,
      message: "Upload saved. Starting AI analysis..."
    });

    const analysis = await analyseVideo(inputPath, mimeType, jobId);

    updateJob(jobId, {
      stage: "selecting",
      progress: 60,
      message: "AI has selected the scenes. Preparing the edit...",
      clips: analysis.clips
    });

    await renderShort(inputPath, analysis.clips, outputPath, jobId);

    const stats = await fs.promises.stat(outputPath);
    if (!stats.isFile() || stats.size < 1000) {
      throw new Error("The finished video file is invalid.");
    }

    updateJob(jobId, {
      stage: "finalising",
      progress: 95,
      message: "Verifying the finished video..."
    });

    await runCommand(ffmpegPath, [
      "-v", "error",
      "-i", outputPath,
      "-f", "null",
      "-"
    ]);

    if (!fs.existsSync(outputPath)) {
      throw new Error("The finished video disappeared during verification.");
    }

    updateJob(jobId, {
      stage: "ready",
      progress: 100,
      message: "Your video is ready to preview and download.",
      result: {
        videoUrl: `/api/video/${jobId}`,
        downloadUrl: `/api/download/${jobId}`,
        clips: analysis.clips,
        size: stats.size
      }
    });
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);

    updateJob(jobId, {
      stage: "error",
      progress: 0,
      message: error.message || "Video generation failed.",
      error: error.message || "Video generation failed."
    });
  }
}

function getReadyVideo(req, res, download = false) {
  const job = jobs.get(req.params.id);

  if (!job || job.stage !== "ready" || !job.directory) {
    return res.status(404).json({
      error: "This finished video is no longer available. Please create it again."
    });
  }

  const outputPath = path.join(job.directory, "finished-short.mp4");

  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({
      error: "The video file has expired or is missing. Please create it again."
    });
  }

  const stat = fs.statSync(outputPath);
  if (!stat.isFile() || stat.size < 1000) {
    return res.status(404).json({
      error: "The finished video file is invalid. Please create it again."
    });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");

  if (download) {
    return res.download(outputPath, "reelnarrator-short.mp4");
  }

  return res.sendFile(outputPath, {
    headers: {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    }
  });
}

app.post("/api/create-short", (req, res) => {
  upload.single("movie")(req, res, (error) => {
    if (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    if (!ai) {
      return res.status(500).json({
        ok: false,
        error: "GEMINI_API_KEY is missing from the server environment."
      });
    }

    if (!ffmpegPath) {
      return res.status(500).json({
        ok: false,
        error: "FFmpeg is not available on this server."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Please select a video to upload."
      });
    }

    const id = crypto.randomUUID();
    const buffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    jobs.set(id, {
      id,
      stage: "queued",
      progress: 0,
      message: "Video received. Preparing your job...",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null,
      error: null,
      directory: null
    });

    res.status(202).json({
      ok: true,
      id,
      statusUrl: `/api/jobs/${id}`
    });

    processVideo(id, buffer, mimeType).catch((err) => {
      console.error("Unexpected processing error:", err);
      updateJob(id, {
        stage: "error",
        progress: 0,
        message: err.message || "Unexpected processing error.",
        error: err.message || "Unexpected processing error."
      });
    });
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Job not found. The server may have restarted."
    });
  }

  res.set("Cache-Control", "no-store");
  res.json({
    id: job.id,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    result: job.result,
    error: job.error
  });
});

app.get("/api/video/:id", (req, res) => {
  return getReadyVideo(req, res, false);
});

app.get("/api/download/:id", (req, res) => {
  return getReadyVideo(req, res, true);
});

app.post("/api/voice", async (req, res) => {
  res.status(501).json({
    ok: false,
    error: "Voice generation is not connected to the finished video yet."
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "ReelNarrator",
    editor: "AI-analysis-and-video-rendering",
    geminiConfigured: Boolean(API_KEY),
    ffmpegConfigured: Boolean(ffmpegPath)
  });
});

// Remove expired jobs and their temporary files.
setInterval(async () => {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    const updatedAt = Number(job.updatedAt || job.createdAt || now);

    if (now - updatedAt < JOB_TTL_MS) continue;
    if (job.stage !== "ready" && job.stage !== "error") continue;

    jobs.delete(id);

    if (job.directory) {
      await fs.promises.rm(job.directory, {
        recursive: true,
        force: true
      }).catch(() => {});
    }
  }
}, 10 * 60 * 1000).unref();

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);

  res.status(500).json({
    ok: false,
    error: error.message || "An unexpected server error occurred."
  });
});

app.listen(PORT, () => {
  console.log(`ReelNarrator running on port ${PORT}`);
});
    
