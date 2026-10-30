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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, "public");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("Please upload a video file."));
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicPath));

const completedJobs = new Map();

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error("FFmpeg binary is unavailable."));
    }

    const child = spawn(ffmpegPath, args);
    let errorText = "";

    child.stderr.on("data", chunk => {
      errorText += chunk.toString();

      if (errorText.length > 12000) {
        errorText = errorText.slice(-12000);
      }
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(
        `Video processing failed: ${errorText.slice(-1800)}`
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
    throw new Error("AI did not return valid clip selections.");
  }

  return JSON.parse(cleaned.slice(first, last + 1));
}

async function analyseVideo(videoPath, mimeType) {
  const ai = getAI();

  const videoBuffer = await fs.readFile(videoPath);
  const videoBlob = new Blob([videoBuffer], {
    type: mimeType
  });

  const uploaded = await ai.files.upload({
    file: videoBlob,
    config: { mimeType }
  });

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
Analyse this video to prepare one engaging YouTube Short.

Only select moments that are actually present in the video.
Choose 2 to 6 strong moments that form a coherent sequence.
Keep the moments in their original chronological order.
Avoid unrelated scenes and repeated moments.
Aim for a combined duration of 20 to 55 seconds.

Return ONLY valid JSON in this format:
{
  "title": "Short suggested title",
  "clips": [
    {
      "start": 12.5,
      "end": 20.0,
      "reason": "Why this moment is interesting"
    }
  ]
}

Rules:
- start and end must be seconds from the beginning of the video.
- end must be greater than start.
- Each clip must be between 3 and 15 seconds.
- Do not invent timestamps or events.
- Do not include dialogue or copyrighted screenplay text.
- If you cannot identify suitable moments, return {"title":"","clips":[]}.
`
      }
    ]
  });

  return parseAIJson(result.text || "");
}

function validateClips(clips) {
  if (!Array.isArray(clips)) {
    throw new Error("AI returned no usable clip list.");
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

  if (selected.length < 2) {
    throw new Error(
      "The AI could not find at least two suitable moments. Try another video."
    );
  }

  const total = selected.reduce(
    (sum, clip) => sum + clip.end - clip.start,
    0
  );

  if (total > 60) {
    throw new Error("Selected clips exceed the 60-second limit.");
  }

  return selected;
}

async function renderShort(inputPath, clips, workDir) {
  const segmentPaths = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
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

  const listPath = path.join(workDir, "clips.txt");

  const listContent = segmentPaths
    .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
    .join("\n");

  await fs.writeFile(listPath, listContent);

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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ReelNarrator",
    editor: "highlight-selection-and-rendering"
  });
});

// Analyse and render an uploaded video.
app.post(
  "/api/create-short",
  upload.single("movie"),
  async (req, res) => {
    const workDir = path.join(os.tmpdir(), `reelnarrator-${randomUUID()}`);

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Choose a video file first."
        });
      }

      await fs.mkdir(workDir, { recursive: true });

      const extension = path.extname(req.file.originalname) || ".mp4";
      const inputPath = path.join(workDir, `source${extension}`);

      await fs.writeFile(inputPath, req.file.buffer);

      res.setHeader("X-Content-Type-Options", "nosniff");

      const analysis = await analyseVideo(
        inputPath,
        req.file.mimetype
      );

      const clips = validateClips(analysis.clips);

      const outputPath = await renderShort(
        inputPath,
        clips,
        workDir
      );

      const id = randomUUID();

      completedJobs.set(id, {
        path: outputPath,
        workDir,
        createdAt: Date.now()
      });

      res.json({
        ok: true,
        id,
        title: analysis.title || "Your ReelNarrator Short",
        clips,
        duration: clips.reduce(
          (sum, clip) => sum + clip.end - clip.start,
          0
        ),
        downloadUrl: `/api/download/${id}`
      });

    } catch (err) {
      console.error("Create Short error:", err);

      await fs.rm(workDir, {
        recursive: true,
        force: true
      }).catch(() => {});

      res.status(500).json({
        error: err.message || "Could not create your Short."
      });
    }
  }
);

// Download the finished MP4.
app.get("/api/download/:id", async (req, res) => {
  const job = completedJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "This video is no longer available. Create it again."
    });
  }

  res.download(
    job.path,
    "reelnarrator-short.mp4"
  );
});

// Generate voice with ElevenLabs.
app.post("/api/voice", async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({
        error: "ElevenLabs API key is not configured."
      });
    }

    const text = String(req.body?.text || "").trim();
    const voiceId = String(
      req.body?.voiceId || "21m00Tcm4TlvDq8ikWAM"
    );

    if (!text) {
      return res.status(400).json({
        error: "Write a narration first."
      });
    }

    if (text.length > 12000) {
      return res.status(400).json({
        error: "Maximum narration length is 12,000 characters."
      });
    }

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
      const detail = await response.text();
      return res.status(response.status).json({
        error: `ElevenLabs error: ${detail.slice(0, 400)}`
      });
    }

    const audio = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audio);

  } catch (err) {
    console.error("Voice error:", err);

    res.status(500).json({
      error: err.message || "Could not generate voice."
    });
  }
});

// Remove expired temporary files.
setInterval(async () => {
  const expiry = Date.now() - 60 * 60 * 1000;

  for (const [id, job] of completedJobs) {
    if (job.createdAt < expiry) {
      completedJobs.delete(id);
      await fs.rm(job.workDir, {
        recursive: true,
        force: true
      }).catch(() => {});
    }
  }
}, 10 * 60 * 1000).unref();

app.use((err, _req, res, _next) => {
  if (
    err instanceof multer.MulterError &&
    err.code === "LIMIT_FILE_SIZE"
  ) {
    return res.status(413).json({
      error: `Video is too large. Maximum size is ${maxMb} MB.`
    });
  }

  res.status(400).json({
    error: err.message || "Request failed."
  });
});

app.listen(port, () => {
  console.log(`ReelNarrator running on port ${port}`);
});
        
