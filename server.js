import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(process.cwd(), "public");
const TEMP_DIR = path.join(os.tmpdir(), "reelnarrations");
const JOBS_DIR = path.join(TEMP_DIR, "jobs");
const UPLOADS_DIR = path.join(TEMP_DIR, "uploads");

for (const dir of [TEMP_DIR, JOBS_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: "20mb" }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
});

const jobs = new Map();

function parseJsonField(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getSettings(value) {
  const raw = parseJsonField(value, {});
  return {
    format: ["9:16", "16:9", "1:1"].includes(raw.format)
      ? raw.format
      : "9:16",
    targetDuration: Math.min(
      180,
      Math.max(15, Number(raw.targetDuration) || 60)
    ),
    recapStyle: String(raw.recapStyle || "Engaging movie recap").slice(0, 500),
    voiceType: String(raw.voiceType || "Kore").slice(0, 80),
    voiceAccent: String(raw.voiceAccent || "English").slice(0, 80),
    voiceSpeed: Math.min(1.5, Math.max(0.7, Number(raw.voiceSpeed) || 1)),
    scriptInstructions: String(raw.scriptInstructions || "").slice(0, 3000),
    includeCaptions: raw.includeCaptions !== false,
    captionPosition: String(raw.captionPosition || "bottom").slice(0, 40),
    captionSize: String(raw.captionSize || "normal").slice(0, 40),
    captionColor: String(raw.captionColor || "white").slice(0, 40),
  };
}

function getGemini(req) {
  const key = String(req.body?.geminiApiKey || "").trim();
  if (!key) throw new Error("Add your Gemini API key in API Settings.");
  return new GoogleGenAI({ apiKey: key });
}

function getGroq() {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("The server's Groq API key is not configured.");
  return new Groq({ apiKey: key });
}

function command(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => stdout += chunk.toString());
    child.stderr.on("data", chunk => stderr += chunk.toString());
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${cmd} failed with code ${code}`));
    });
  });
}

function ffmpeg(args) {
  return command("ffmpeg", ["-y", ...args]);
}

async function getDuration(file) {
  const { stdout } = await command("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(stdout.trim()) || 0;
}

function extractJson(text) {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("AI returned an invalid response. Please try again.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function createJob() {
  const id = crypto.randomUUID();
  const directory = path.join(JOBS_DIR, id);
  fs.mkdirSync(directory, { recursive: true });

  const job = {
    id,
    directory,
    stage: "queued",
    progress: 0,
    message: "Starting...",
    error: null,
    result: null,
    createdAt: Date.now(),
  };

  jobs.set(id, job);
  return job;
}

function setJob(job, stage, progress, message) {
  job.stage = stage;
  job.progress = progress;
  job.message = message;
}

function validateClips(clips, videoDuration) {
  if (!Array.isArray(clips)) {
    throw new Error("AI returned an invalid scene list.");
  }

  const normalized = clips
    .map(clip => {
      const start = Number(clip.start);
      const end = Number(clip.end);

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        start >= videoDuration ||
        end > videoDuration + 0.5
      ) {
        return null;
      }

      return {
        start,
        end: Math.min(end, videoDuration),
        description: String(clip.description || clip.reason || "").trim(),
        reason: String(clip.reason || "").trim(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (normalized.length < 2) {
    throw new Error(
      "Gemini returned fewer than 2 valid scenes. Please try again."
    );
  }

  return normalized;
}

function parseManualClips(raw, videoDuration) {
  const clips = parseJsonField(raw, []);
  if (!Array.isArray(clips) || clips.length < 2 || clips.length > 6) {
    throw new Error("Manual mode needs between 2 and 6 scenes.");
  }

  const normalized = clips.map((clip, index) => {
    const start = Number(clip.start);
    const end = Number(clip.end);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > videoDuration
    ) {
      throw new Error(`Check the timestamps for scene ${index + 1}.`);
    }

    return {
      start,
      end,
      description: "",
      reason: "Manually selected scene",
    };
  }).sort((a, b) => a.start - b.start);

  const total = normalized.reduce((sum, clip) => sum + clip.end - clip.start, 0);
  if (total < 10 || total > 90) {
    throw new Error("Selected scenes must total between 10 and 90 seconds.");
  }

  return normalized;
}

async function analyzeScenes(req, videoPath, duration, mode, manualClips) {
  const ai = getGemini(req);
  const uploaded = await ai.files.upload({
    file: videoPath,
    config: { mimeType: "video/mp4" },
  });

  const manual = mode === "manual";
  const sceneRanges = manual
    ? manualClips.map(({ start, end }) => ({ start, end }))
    : [];

  const prompt = `
Analyze the uploaded movie video and return JSON only.

${manual
  ? `Analyze these exact ranges, in the same order:
${JSON.stringify(sceneRanges)}
Return one factual visible-action description for each range.`
  : `Select 3 to 15 useful, visually distinct scenes in chronological order.
Avoid repeated shots and avoid jumping backward or forward in time.`}

Return:
{
  "clips": [
    {
      "start": 0,
      "end": 8,
      "description": "What is visibly happening in this scene."
    }
  ]
}

Rules:
- Timestamps are seconds and must be within the ${duration}-second video.
- Do not invent events, dialogue, or details.
- Keep scenes chronological.
- Return valid JSON only.
`;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_VIDEO_MODEL || "gemini-3.8-flash",
    contents: [{
      role: "user",
      parts: [
        {
          fileData: {
            fileUri: uploaded.uri,
            mimeType: uploaded.mimeType,
          },
        },
        { text: prompt },
      ],
    }],
    config: { responseMimeType: "application/json" },
  });

  const parsed = extractJson(response.text);
  let clips = validateClips(parsed.clips, duration);

  if (manual) {
    clips = manualClips.map((range, index) => ({
      start: range.start,
      end: range.end,
      description:
        clips[index]?.description ||
        `Visible action from ${range.start} to ${range.end} seconds`,
      reason: "Manually selected scene",
    }));
  }
  return clips;
}
