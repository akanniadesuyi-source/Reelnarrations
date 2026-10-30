
import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import ffmpegPath from "ffmpeg-static";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const maxMb = Number(process.env.MAX_UPLOAD_MB || 100);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("Please upload a video file."));
  }
});

const jobs = new Map();

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function updateJob(id, stage, progress, message) {
  const job = jobs.get(id);
  if (!job) return;

  job.stage = stage;
  job.progress = progress;
  job.message = message;
  job.updatedAt = Date.now();
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error("FFmpeg is unavailable."));
    }

    const child = spawn(ffmpegPath, args);
    let errorText = "";

    child.stderr.on("data", chunk => {
      errorText += chunk.toString();
      if (errorText.length > 10000) {
        errorText = errorText.slice(-10000);
      }
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(
        `Video rendering failed: ${errorText.slice(-1200)}`
      ));
    });
  });
}

function parseAIJson(text) {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first < 0 || last < first) {
    throw new Error("AI returned an invalid clip selection.");
  }

  return JSON.parse(cleaned.slice(first, last + 1));
}

async function analyseVideo(videoPath, mimeType, jobId) {
  updateJob(jobId, "analysing", 25, "AI is analysing your video.");

  const ai = getAI();

  const uploaded = await ai.files.upload({
    file: videoPath,
    config: { mimeType }
  });

  if (!uploaded.name || !uploaded.uri) {
    throw new Error("Gemini could not upload the video for analysis.");
  }

  let file = uploaded;

  for (let attempt = 0; attempt < 30; attempt++) {
    if (file.state === "ACTIVE") break;

    if (file.state === "FAILED") {
      throw new Error("Gemini could not process this video.");
    }

    updateJob(
      jobId,
      "analysing",
      30,
      "Preparing video for AI analysis."
    );

    await new Promise(resolve => setTimeout(resolve, 2000));
    file = await ai.files.get({ name: uploaded.name });
  }

  if (file.state !== "ACTIVE") {
    throw new Error("Video analysis preparation timed out.");
  }

  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        fileData: {
          fileUri: uploaded.uri,
          mimeType
        }
      },
      {
        text: `
Find 2 to 6 interesting moments in this video for one coherent YouTube Short.

Keep the moments in chronological order.
Choose moments that connect into a clear mini-story.
Each moment must be 3 to 15 seconds.
Total selected duration must be between 20 and 55 seconds.
Use only moments actually present in the video.

Return only JSON:
{
  "title": "Suggested Short title",
  "clips": [
    {
      "start": 10,
      "end": 18,
      "reason": "Why this moment is interesting"
    }
  ]
}

Timestamps must be seconds from the start of the video.
If suitable moments cannot be identified, return:
{"title":"","clips":[]}
`
      }
    ]
  });

  return parseAIJson(result.text || "");
}

function validateClips(clips) {
  if (!Array.isArray(clips)) {
    throw new Error("No clip selections were returned.");
  }

  const selected = clips
    .filter(clip =>
      Number.isFinite(Number(clip.start)) &&
      Number.isFinite(Number(clip.end)) &&
      Number(clip.start) >= 0 &&
      Number(clip.end) > Number(clip.start) &&
      Number(clip.end) - Number(clip.start) >= 3 &&
      Number(clip.end) - Number(clip.start) <= 15
    )
    .slice(0, 6)
    .map(clip => ({
      start: Number(clip.start),
      end: Number(clip.end),
      reason: String(clip.reason || "Selected highlight")
    }))
    .sort((a, b) => a.start - b.start);

  const total = selected.reduce(
    (sum, clip) => sum + clip.end - clip.start,
    0
  );

  if (selected.length < 2 || total < 20 || total > 60) {
    throw new Error(
      "AI could not find enough suitable moments. Try another video."
    );
  }

  return selected;
}

async function renderShort(inputPath, clips, workDir, jobId) {
  const segmentPaths = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];

    updateJob(
      jobId,
      "rendering",
      55 + Math.round((i / clips.length) * 30),
      `Rendering selected moment ${i + 1} of ${clips.length}.`
    );

    const segmentPath = path.join(workDir, `clip-${i}.mp4`);

    await runFFmpeg([
      "-y",
      "-ss", String(clip.start),
      "-i", inputPath,
      "-t", String(clip.end - clip.start),
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-an",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      segmentPath
    ]);

    segmentPaths.push(segmentPath);
  }

  updateJob(jobId, "rendering", 90, "Joining the selected moments.");

  const listPath = path.join(workDir, "clips.txt");

  await fs.writeFile(
    listPath,
    segmentPaths.map(file => `file '${file}'`).join("\n")
  );

  const outputPath = path.join(workDir, "reelnarrator-short.mp4");

  await runFFmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    outputPath
  ]);

  return outputPath;
}

async function processVideo(jobId, file) {
  const workDir = path.join(os.tmpdir(), `reelnarrator-${jobId}`);

  try {
    await fs.mkdir(workDir, { recursive: true });

    updateJob(jobId, "saving", 10, "Saving your uploaded video.");

    const extension = path.extname(file.originalname) || ".mp4";
    const inputPath = path.join(workDir, `source${extension}`);

    await fs.writeFile(inputPath, file.buffer);

    updateJob(jobId, "analysing", 20, "Starting AI video analysis.");

    const analysis = await analyseVideo(
      inputPath,
      file.mimetype,
      jobId
    );

    updateJob(jobId, "selecting", 50, "Selecting the best moments.");

    const clips = validateClips(analysis.clips);

    const outputPath = await renderShort(
      inputPath,
      clips,
      workDir,
      jobId
    );

    const job = jobs.get(jobId);

    if (!job) throw new Error("Processing job expired.");

    job.result = {
      title: analysis.title || "Your ReelNarrator Short",
      clips,
      duration: clips.reduce(
        (sum, clip) => sum + clip.end - clip.start,
        0
      ),
      downloadUrl: `/api/download/${jobId}`
    };

    job.workDir = workDir;
    job.outputPath = outputPath;

    updateJob(jobId, "ready", 100, "Your Short is ready.");

  } catch (error) {
    console.error("Video processing error:", error);

    const job = jobs.get(jobId);

    if (job) {
      job.stage = "failed";
      job.message = error.message || "Video processing failed.";
      job.updatedAt = Date.now();
    }

    await fs.rm(workDir, {
      recursive: true,
      force: true
    }).catch(() => {});
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ReelNarrator",
    editor: "background-video-processing"
  });
});

// Start a video job.
app.post("/api/create-short", upload.single("movie"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "Choose a video file first."
    });
  }

  const id = randomUUID();

  jobs.set(id, {
    stage: "queued",
    progress: 0,
    message: "Your video is in the queue.",
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  processVideo(id, req.file).catch(error => {
    console.error("Background job error:", error);
  });

  res.status(202).json({
    ok: true,
    id,
    statusUrl: `/api/jobs/${id}`
  });
});

// Read live job status.
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Processing job not found or expired."
    });
  }

  res.json({
    id: req.params.id,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    result: job.result || null
  });
});

// Download finished video.
app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.stage !== "ready" || !job.outputPath) {
    return res.status(404).json({
      error: "Your video is not ready or is no longer available."
    });
  }

  res.download(job.outputPath, "reelnarrator-short.mp4");
});

// Voice generation.
app.post("/api/voice", async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({
        error: "ElevenLabs API key is not configured."
      });
    }

    const text = String(req.body?.text || "").trim();

    if (!text || text.length > 12000) {
      return res.status(400).json({
        error: "Enter narration up to 12,000 characters."
      });
    }

    const voiceId = String(
      req.body?.voiceId || "21m00Tcm4TlvDq8ikWAM"
    );

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2"
        })
      }
    );

    if (!response.ok) {
      throw new Error("Voice provider could not generate audio.");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(await response.arrayBuffer()));

  } catch (error) {
    res.status(500).json({
      error: error.message || "Voice generation failed."
    });
  }
});

// Clean up expired jobs.
setInterval(async () => {
  const expiry = Date.now() - 60 * 60 * 1000;

  for (const [id, job] of jobs) {
    if (job.updatedAt < expiry) {
      jobs.delete(id);

      if (job.workDir) {
        await fs.rm(job.workDir, {
          recursive: true,
          force: true
        }).catch(() => {});
      }
    }
  }
}, 10 * 60 * 1000).unref();

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError &&
      error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `Video is too large. Maximum size is ${maxMb} MB.`
    });
  }

  res.status(400).json({
    error: error.message || "Request failed."
  });
});

app.listen(port, () => {
  console.log(`ReelNarrator running on port ${port}`);
});
      
