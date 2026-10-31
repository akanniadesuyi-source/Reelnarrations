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
  limits: { fileSize: 500 * 1024 * 1024 }
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

    recapStyle: String(
      raw.recapStyle || "Engaging movie recap"
    ).slice(0, 500),

    voiceType: String(raw.voiceType || "Kore").slice(0, 80),
    voiceAccent: String(raw.voiceAccent || "English").slice(0, 80),

    voiceSpeed: Math.min(
      1.5,
      Math.max(0.7, Number(raw.voiceSpeed) || 1)
    ),

    scriptInstructions: String(
      raw.scriptInstructions || ""
    ).slice(0, 3000),

    includeCaptions: raw.includeCaptions !== false,
    captionPosition: String(raw.captionPosition || "bottom").slice(0, 40),
    captionSize: String(raw.captionSize || "normal").slice(0, 40),
    captionColor: String(raw.captionColor || "white").slice(0, 40)
  };
}

function getGemini(req) {
  const key = String(req.body?.geminiApiKey || "").trim();

  if (!key) {
    throw new Error("Add your Gemini API key in API Settings.");
  }

  return new GoogleGenAI({ apiKey: key });
}

function getGroq() {
  const key = process.env.GROQ_API_KEY;

  if (!key) {
    throw new Error("The server's Groq API key is not configured.");
  }

  return new Groq({ apiKey: key });
}

function command(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
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
      reject(new Error(
        `${cmd} could not start: ${error.message}`
      ));
    });

    child.on("close", code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `${cmd} failed with code ${code}`));
      }
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
    file
  ]);

  const duration = Number(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not read the uploaded video's duration.");
  }

  return duration;
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
    clips: [],
    narration: "",
    videoPath: null,
    createdAt: Date.now()
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
        description: String(
          clip.description || clip.reason || ""
        ).trim(),
        reason: String(clip.reason || "").trim()
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
      reason: "Manually selected scene"
    };
  }).sort((a, b) => a.start - b.start);

  const total = normalized.reduce(
    (sum, clip) => sum + clip.end - clip.start,
    0
  );

  if (total < 10 || total > 90) {
    throw new Error("Selected scenes must total between 10 and 90 seconds.");
  }

  return normalized;
}

async function analyzeScenes(
  req,
  videoPath,
  duration,
  mode,
  manualClips
) {
  const ai = getGemini(req);

  const uploaded = await ai.files.upload({
    file: videoPath,
    config: { mimeType: "video/mp4" }
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
            mimeType: uploaded.mimeType
          }
        },
        { text: prompt }
      ]
    }],

    config: {
      responseMimeType: "application/json"
    }
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
      reason: "Manually selected scene"
    }));
  }

  return clips;
      });
  }

  return clips;
      }
async function generateNarration(clips, settings) {
  const groq = getGroq();

  const prompt = `
Write a complete movie recap narration using these scenes in chronological order.

SCENES:
${clips.map((clip, index) => `
Scene ${index + 1}
Time: ${clip.start} to ${clip.end} seconds
Visible action: ${clip.description}
`).join("\n")}

STYLE:
${settings.recapStyle}

ADDITIONAL INSTRUCTIONS:
${settings.scriptInstructions || "None"}

RULES:
- Explain what is happening in the scenes.
- Connect every scene naturally to the next.
- Use simple, natural sentences.
- Do not use character names.
- Do not invent events or dialogue.
- Do not add a generic introduction or hook.
- Return narration only.
`;

  const response = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "You write clear, engaging and chronological movie recaps."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0.7
  });

  const narration = response.choices?.[0]?.message?.content?.trim();

  if (!narration) {
    throw new Error("Could not generate the narration.");
  }

  return narration;
}

async function generateSpeech(req, narration, settings, outputFile) {
  const ai = getGemini(req);

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_TTS_MODEL ||
      "gemini-2.5-flash-preview-tts",
    contents: [
      {
        parts: [{ text: narration }]
      }
    ],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: settings.voiceType || "Kore"
          }
        }
      }
    }
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find(part => part.inlineData?.data);

  if (!audioPart) {
    throw new Error("Gemini did not return narration audio.");
  }

  const audioBuffer = Buffer.from(
    audioPart.inlineData.data,
    "base64"
  );

  const mimeType = audioPart.inlineData.mimeType || "audio/pcm";
  const sampleRate = Number(
    mimeType.match(/rate=(\d+)/)?.[1] || 24000
  );

  const rawFile = outputFile.replace(/\.wav$/i, ".pcm");

  fs.writeFileSync(rawFile, audioBuffer);

  try {
    await ffmpeg([
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-i", rawFile,
      "-filter:a", `atempo=${settings.voiceSpeed}`,
      "-c:a", "pcm_s16le",
      outputFile
    ]);
  } finally {
    fs.rmSync(rawFile, { force: true });
  }

  return outputFile;
}

function escapeSubtitleText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ");
}

function getAspectRatio(format) {
  if (format === "16:9") return "1920:1080";
  if (format === "1:1") return "1080:1080";
  return "1080:1920";
}

function createSrt(narration, duration, outputFile) {
  const words = String(narration || "").trim().split(/\s+/).filter(Boolean);

  if (!words.length) {
    fs.writeFileSync(outputFile, "");
    return outputFile;
  }

  const maxWords = 8;
  const groups = [];

  for (let i = 0; i < words.length; i += maxWords) {
    groups.push(words.slice(i, i + maxWords).join(" "));
  }

  const secondsPerGroup = duration / groups.length;

  const timestamp = seconds => {
    const milliseconds = Math.max(0, Math.floor(seconds * 1000));
    const hours = String(Math.floor(milliseconds / 3600000)).padStart(2, "0");
    const minutes = String(Math.floor((milliseconds % 3600000) / 60000)).padStart(2, "0");
    const secs = String(Math.floor((milliseconds % 60000) / 1000)).padStart(2, "0");
    const ms = String(milliseconds % 1000).padStart(3, "0");

    return `${hours}:${minutes}:${secs},${ms}`;
  };

  const content = groups.map((group, index) => {
    const start = index * secondsPerGroup;
    const end = Math.min(duration, (index + 1) * secondsPerGroup);

    return `${index + 1}
${timestamp(start)} --> ${timestamp(end)}
${group}`;
  }).join("\n\n");

  fs.writeFileSync(outputFile, content, "utf8");

  return outputFile;
}

async function createFinalVideo(job, req, settings, narration) {
  const sourceVideo = job.videoPath;

  if (!sourceVideo || !fs.existsSync(sourceVideo)) {
    throw new Error("The uploaded video could not be found.");
  }

  const audioFile = path.join(job.directory, "narration.wav");
  const outputFile = path.join(job.directory, "final.mp4");

  setJob(job, "voice", 75, "Generating narration voice...");

  await generateSpeech(req, narration, settings, audioFile);

  const videoDuration = await getDuration(sourceVideo);

  const args = [
    "-i", sourceVideo,
    "-i", audioFile
  ];

  let filter;

  const ratio = getAspectRatio(settings.format);

  if (settings.format === "16:9") {
    filter = "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1[v]";
  } else if (settings.format === "1:1") {
    filter = "[0:v]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,setsar=1[v]";
  } else {
    filter = "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v]";
  }

  let videoMap = "[v]";

  if (settings.includeCaptions) {
    const subtitleFile = path.join(job.directory, "captions.srt");

    createSrt(narration, videoDuration, subtitleFile);

    const subtitlePath = subtitleFile
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'");

    const color = settings.captionColor === "yellow"
      ? "&H0000FFFF"
      : settings.captionColor === "black"
        ? "&H00000000"
        : "&H00FFFFFF";

    const fontSize = settings.captionSize === "small"
      ? 18
      : settings.captionSize === "large"
        ? 34
        : 26;

    const alignment = settings.captionPosition === "top" ? 6 : 2;

    filter += `;[v]subtitles='${subtitlePath}':force_style='FontSize=${fontSize},PrimaryColour=${color},Alignment=${alignment},Outline=2'[captioned]`;

    videoMap = "[captioned]";
  }

  args.push(
    "-filter_complex", filter,
    "-map", videoMap,
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    outputFile
  );

  setJob(job, "rendering", 90, "Rendering your final video...");

  await ffmpeg(args);

  if (!fs.existsSync(outputFile)) {
    throw new Error("The final video could not be created.");
  }

  job.videoPath = outputFile;

  return outputFile;
    }
app.post("/api/create-short", upload.single("movie"), async (req, res) => {
  let job;

  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Choose a movie video first."
      });
    }

    const settings = getSettings(req.body.settings);
    const jobMode = req.body.mode === "manual" ? "manual" : "auto";

    job = createJob();

    const extension = path.extname(req.file.originalname) || ".mp4";
    const videoPath = path.join(job.directory, `uploaded${extension}`);

    fs.renameSync(req.file.path, videoPath);

    job.videoPath = videoPath;
    job.settings = settings;

    const manualClips = jobMode === "manual"
      ? parseManualClips(req.body.manualClips, await getDuration(videoPath))
      : [];

    res.status(202).json({
      ok: true,
      id: job.id
    });

    processJob(job, req, settings, jobMode, manualClips).catch(error => {
      console.error("Processing failed:", error);
      job.error = error.message || "Processing failed.";
      setJob(job, "error", job.progress, job.error);
    });

  } catch (error) {
    console.error("Upload failed:", error);

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.rmSync(req.file.path, { force: true });
    }

    if (job) {
      jobs.delete(job.id);
      fs.rmSync(job.directory, { recursive: true, force: true });
    }

    res.status(400).json({
      ok: false,
      error: error.message || "Could not upload the video."
    });
  }
});

async function processJob(job, req, settings, mode, manualClips) {
  try {
    setJob(job, "analyzing", 25, "Analysing movie scenes...");

    const duration = await getDuration(job.videoPath);

    job.clips = await analyzeScenes(
      req,
      job.videoPath,
      duration,
      mode,
      manualClips
    );

    setJob(job, "writing_script", 55, "Writing your movie recap...");

    job.narration = await generateNarration(job.clips, settings);

    job.result = {
      narration: job.narration,
      clips: job.clips
    };

    setJob(job, "script_ready", 65, "Your narration is ready for review.");

  } catch (error) {
    console.error("Job processing failed:", error);
    setJob(job, "error", job.progress, error.message);
    job.error = error.message;
  }
}

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "Job not found."
    });
  }

  res.json({
    ok: true,
    id: job.id,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    result: job.result
  });
});

app.post("/api/jobs/:id/regenerate-script", async (req, res) => {
  try {
    const job = jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job not found."
      });
    }

    const settings = getSettings(req.body.settings);

    setJob(job, "writing_script", 60, "Regenerating narration...");

    const narration = await generateNarration(job.clips, settings);

    job.narration = narration;
    job.settings = settings;
    job.result = {
      narration,
      clips: job.clips
    };

    setJob(job, "script_ready", 65, "New narration is ready.");

    res.json({
      ok: true,
      narration,
      clips: job.clips
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Could not regenerate narration."
    });
  }
});

app.post("/api/jobs/:id/finalize", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "Job not found."
    });
  }

  try {
    const narration = String(req.body.narration || "").trim();

    if (narration.length < 20) {
      return res.status(400).json({
        ok: false,
        error: "Please provide a longer narration."
      });
    }

    const settings = getSettings(req.body.settings);

    job.narration = narration;
    job.settings = settings;

    res.status(202).json({
      ok: true,
      message: "Final video generation started."
    });

    (async () => {
      try {
        await createFinalVideo(job, req, settings, narration);

        job.result = {
          narration,
          clips: job.clips,
          videoUrl: `/api/jobs/${job.id}/video`,
downloadUrl: `/api/jobs/${job.id}/download`
        };

        setJob(job, "ready", 100, "Your recap is ready.");

      } catch (error) {
        console.error("Final video failed:", error);
        job.error = error.message;
        setJob(job, "error", job.progress, error.message);
      }
    })();

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Could not finalize the video."
    });
  }
});

app.get("/api/jobs/:id/video", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.stage !== "ready" || !job.videoPath) {
    return res.status(404).json({
      ok: false,
      error: "Video is not ready yet."
    });
  }

  if (!fs.existsSync(job.videoPath)) {
    return res.status(404).json({
      ok: false,
      error: "Video file not found."
    });
  }

  res.type("video/mp4");
  res.sendFile(job.videoPath);
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.stage !== "ready" || !job.videoPath) {
    return res.status(404).json({
      ok: false,
      error: "Video is not ready yet."
    });
  }

  if (!fs.existsSync(job.videoPath)) {
    return res.status(404).json({
      ok: false,
      error: "Video file not found."
    });
  }

  res.download(job.videoPath, "reelnarrations.mp4");
});

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) {
      jobs.delete(id);

      try {
        fs.rmSync(job.directory, {
          recursive: true,
          force: true
        });
      } catch (error) {
        console.error("Cleanup failed:", error);
      }
    }
  }
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`ReelNarrations server listening on port ${PORT}`);
});
