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
  if (!Array.isArray(clips) || clips.length < 2) {
    throw new Error("Could not identify enough scenes in the video.");
  }

  const normalized = clips.map((clip, index) => {
    const start = Number(clip.start);
    const end = Number(clip.end);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > videoDuration + 0.5
    ) {
      throw new Error(`Scene ${index + 1} has invalid timestamps.`);
    }

    return {
      start,
      end,
      description: String(clip.description || clip.reason || "").trim(),
      reason: String(clip.reason || "").trim(),
    };
  });

  normalized.sort((a, b) => a.start - b.start);
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

async function createNarration(clips, settings) {
  const groq = getGroq();

  const prompt = `
Write a clear, engaging movie recap narration matching these scenes.
Follow the scene order exactly. Do not jump between unrelated moments.

Style: ${settings.recapStyle}
Additional instructions: ${settings.scriptInstructions || "None"}

Rules:
- Natural, simple spoken English.
- No generic opening hook.
- Do not use character names; describe people by role or appearance.
- Do not invent plot events beyond the scene descriptions.
- Keep each scene's narration concise but meaningful.
- Return JSON with one narration entry per scene, in the same order.

Scenes:
${JSON.stringify(clips, null, 2)}

Required format:
{
  "sceneNarration": [
    "Narration for scene one",
    "Narration for scene two"
  ]
}
`;

  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: 0.65,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Write coherent, scene-matched movie recaps." },
      { role: "user", content: prompt },
    ],
  });

  const parsed = extractJson(completion.choices?.[0]?.message?.content || "");
  if (
    !Array.isArray(parsed.sceneNarration) ||
    parsed.sceneNarration.length !== clips.length
  ) {
    throw new Error("Narration did not match the selected scenes.");
  }

  return parsed.sceneNarration.map(line =>
    String(line || "").replace(/\s+/g, " ").trim()
  );
}

function joinNarration(lines) {
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

async function reviseNarration(job, settings) {
  const groq = getGroq();

  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Revise movie recap narration while preserving scene order.",
      },
      {
        role: "user",
        content: `
Rewrite the recap to be more natural and engaging.
Keep it scene-matched, chronological, and factually grounded.
Do not use character names or add events.
Style: ${settings.recapStyle}
Extra instructions: ${settings.scriptInstructions || "None"}

Scenes:
${JSON.stringify(job.clips, null, 2)}

Current narration:
${job.narration}

Return JSON with "sceneNarration", exactly ${job.clips.length} entries.
`,
      },
    ],
  });

  const parsed = extractJson(completion.choices?.[0]?.message?.content || "");
  if (
    !Array.isArray(parsed.sceneNarration) ||
    parsed.sceneNarration.length !== job.clips.length
  ) {
    throw new Error("The regenerated narration did not match the scenes.");
  }

  job.sceneNarration = parsed.sceneNarration.map(line =>
    String(line || "").replace(/\s+/g, " ").trim()
  );
  job.narration = joinNarration(job.sceneNarration);

  return {
    narration: job.narration,
    clips: job.clips,
  };
}

async function createVideo(job, req) {
  setJob(job, "rendering", 5, "Preparing scenes...");

  const resolution = job.settings.format === "16:9"
    ? [1920, 1080]
    : job.settings.format === "1:1"
    ? [1080, 1080]
    : [1080, 1920];

  const [width, height] = resolution;
  const sceneFiles = [];

  for (let i = 0; i < job.clips.length; i++) {
    const clip = job.clips[i];
    const scenePath = path.join(job.directory, `scene-${i}.mp4`);
    const length = clip.end - clip.start;

    await ffmpeg([
      "-ss", String(clip.start),
      "-i", job.sourceVideo,
      "-t", String(length),
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`,
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      scenePath,
    ]);

    sceneFiles.push(scenePath);
    job.progress = 10 + Math.round(((i + 1) / job.clips.length) * 45);
    job.message = `Preparing scene ${i + 1} of ${job.clips.length}...`;
  }

  const concatPath = path.join(job.directory, "concat.txt");
  fs.writeFileSync(
    concatPath,
    sceneFiles.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join("\n")
  );

  const silentPath = path.join(job.directory, "silent.mp4");
  await ffmpeg([
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-c", "copy",
    silentPath,
  ]);

  setJob(job, "rendering", 65, "Generating narration voice...");

  const ai = getGemini(req);
  const voiceName = job.settings.voiceType || "Kore";

  const voiceResponse = await ai.models.generateContent({
    model: process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts",
    contents: [{
      role: "user",
      parts: [{ text: job.narration }],
    }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const audioPart = voiceResponse.candidates?.[0]?.content?.parts?.find(
    part => part.inlineData?.data
  );

  if (!audioPart?.inlineData?.data) {
    throw new Error("Voice generation returned no audio.");
  }

  const rawAudio = path.join(job.directory, "voice.raw");
  const audioPath = path.join(job.directory, "voice.m4a");
  const mime = audioPart.inlineData.mimeType || "audio/pcm";

  fs.writeFileSync(rawAudio, Buffer.from(audioPart.inlineData.data, "base64"));

  let audioInput;
  if (mime.includes("wav")) {
    audioInput = ["-i", rawAudio];
  } else if (mime.includes("mpeg") || mime.includes("mp3")) {
    audioInput = ["-f", "mp3", "-i", rawAudio];
  } else {
    audioInput = ["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", rawAudio];
  }

  await ffmpeg([
    ...audioInput,
    "-filter:a", `atempo=${job.settings.voiceSpeed}`,
    "-c:a", "aac",
    "-b:a", "192k",
    audioPath,
  ]);

  let videoForMux = silentPath;

  if (job.settings.includeCaptions) {
    setJob(job, "rendering", 85, "Adding captions...");
    const srtPath = path.join(job.directory, "captions.srt");
    const captionedPath = path.join(job.directory, "captioned.mp4");

    let time = 0;
    const subtitles = [];

    const fmt = seconds => {
      const total = Math.round(seconds * 1000);
      const h = Math.floor(total / 3600000);
      const m = Math.floor((total % 3600000) / 60000);
      const s = Math.floor((total % 60000) / 1000);
      const ms = total % 1000;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
    };

    job.sceneNarration.forEach((line, index) => {
      const duration = job.clips[index].end - job.clips[index].start;
      const words = String(line || "").split(/\s+/).filter(Boolean);
      const chunks = [];

      for (let i = 0; i < words.length; i += 8) {
        chunks.push(words.slice(i, i + 8).join(" "));
      }

      const chunkLength = duration / Math.max(chunks.length, 1);
      chunks.forEach((chunk, chunkIndex) => {
        const start = time + chunkIndex * chunkLength;
        const end = Math.min(time + duration, start + chunkLength);
        subtitles.push(
          `${subtitles.length + 1}\n${fmt(start)} --> ${fmt(end)}\n${chunk}\n`
        );
      });
      time += duration;
    });

    fs.writeFileSync(srtPath, subtitles.join("\n"), "utf8");

    await ffmpeg([
      "-i", silentPath,
      "-vf", `subtitles=${srtPath.replace(/:/g, "\\:")}`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      captionedPath,
    ]);

    videoForMux = captionedPath;
  }

  setJob(job, "rendering", 93, "Combining video and voice...");

  const finalPath = path.join(job.directory, "final.mp4");
  await ffmpeg([
    "-i", videoForMux,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    "-movflags", "+faststart",
    finalPath,
  ]);

  job.result = {
    narration: job.narration,
    clips: job.clips,
    videoUrl: `/api/jobs/${job.id}/video`,
    downloadUrl: `/api/jobs/${job.id}/download`,
  };

  setJob(job, "ready", 100, "Your recap is ready.");
}

app.post("/api/create-short", upload.single("movie"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "Choose a video first." });
  }

  try {
    getGemini(req);
    getGroq();

    const settings = getSettings(req.body.settings);
    const mode = req.body.mode === "manual" ? "manual" : "auto";
    const manualClips = parseJsonField(req.body.manualClips, []);
    const job = createJob();

    job.settings = settings;
    job.mode = mode;
    job.sourceVideo = path.join(job.directory, "source.mp4");
    fs.copyFileSync(req.file.path, job.sourceVideo);
    fs.unlinkSync(req.file.path);

    setJob(job, "processing", 5, "Reading video...");

    (async () => {
      try {
        const duration = await getDuration(job.sourceVideo);
        if (!duration || duration < 3) {
          throw new Error("The uploaded video is too short or unreadable.");
        }

        setJob(job, "processing", 20, "Analyzing scenes...");

        const clips = await analyzeScenes(
          req,
          job.sourceVideo,
          duration,
          mode,
          manualClips
        );

        job.clips = clips;

        setJob(job, "processing", 65, "Writing narration...");
        job.sceneNarration = await createNarration(clips, settings);
        job.narration = joinNarration(job.sceneNarration);

        job.result = {
          narration: job.narration,
          clips: job.clips,
        };

        setJob(job, "script_ready", 100, "Review your narration.");
      } catch (error) {
        job.error = error.message || "Recap creation failed.";
        setJob(job, "error", 100, job.error);
      }
    })();

    res.json({ ok: true, id: job.id });
  } catch (error) {
    try {
      fs.unlinkSync(req.file.path);
    } catch {}
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  res.json({
    id: job.id,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    result: job.result,
  });
});

app.post("/api/jobs/:id/regenerate-script", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found." });
  }

  try {
    const settings = getSettings(req.body.settings);
    const result = await reviseNarration(job, settings);
    job.settings = settings;
    job.result = result;
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/jobs/:id/finalize", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found." });
  }

  try {
    getGemini(req);

    if (job.stage === "rendering") {
      return res.status(409).json({
        ok: false,
        error: "This video is already rendering.",
      });
    }

    const narration = String(req.body.narration || "").trim();
    if (narration.length < 20) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a longer narration.",
      });
    }

    job.settings = getSettings(req.body.settings);
    job.narration = narration;

    job.result = {
      narration: job.narration,
      clips: job.clips,
    };

    createVideo(job, req).catch(error => {
      job.error = error.message || "Final rendering failed.";
      setJob(job, "error", 100, job.error);
    });

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/jobs/:id/video", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.stage !== "ready") {
    return res.status(404).json({ error: "Video is not ready yet." });
  }

  const file = path.join(job.directory, "final.mp4");
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Video file not found." });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHe
