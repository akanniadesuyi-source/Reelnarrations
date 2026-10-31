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

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GEMINI_TTS_MODEL =
  process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Puck";

const ai = GEMINI_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_KEY })
  : null;

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
  Object.assign(job, values, { updatedAt: Date.now() });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let errorOutput = "";

    child.stderr.on("data", chunk => {
      errorOutput += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          `Video processing failed: ${errorOutput.slice(-1500)}`
        ));
      }
    });
  });
}

function parseJSON(text, serviceName) {
  if (!text) {
    throw new Error(`${serviceName} returned an empty response.`);
  }

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new Error(`${serviceName} did not return valid JSON.`);
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error(`${serviceName} returned invalid JSON.`);
  }
}

function validateClips(clips) {
  if (!Array.isArray(clips) || clips.length < 2 || clips.length > 6) {
    throw new Error("Please select between 2 and 6 scenes.");
  }

  const valid = clips.map(clip => ({
    start: Number(clip.start),
    end: Number(clip.end),
    reason: String(clip.reason || "Selected scene"),
    description: String(clip.description || "").trim()
  }));

  for (const clip of valid) {
    if (
      !Number.isFinite(clip.start) ||
      !Number.isFinite(clip.end) ||
      clip.start < 0 ||
      clip.end <= clip.start ||
      clip.end - clip.start < 2 ||
      clip.end - clip.start > 25 ||
      !clip.description
    ) {
      throw new Error(
        "A scene has invalid timestamps or is missing its description."
      );
    }
  }

  valid.sort((a, b) => a.start - b.start);

  const total = valid.reduce(
    (sum, clip) => sum + clip.end - clip.start,
    0
  );

  if (total < 10 || total > 90) {
    throw new Error("Selected scenes must total between 10 and 90 seconds.");
  }

  return valid;
}

function getManualClips(value) {
  let clips;

  try {
    clips = typeof value === "string"
      ? JSON.parse(value)
      : value;
  } catch {
    throw new Error("Manual timestamps are not valid JSON.");
  }

  if (!Array.isArray(clips)) {
    throw new Error("Please provide your manual scene timestamps.");
  }

  return validateClips(
    clips.map((clip, index) => ({
      start: clip.start,
      end: clip.end,
      reason: clip.reason || "Manually selected scene",
      description:
        clip.description || `Scene ${index + 1} selected by the user`
    }))
  );
}

async function generateContentWithRetry(request, jobId) {
  const waits = [2000, 5000, 10000];

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      console.error("GEMINI ERROR:", error?.message || error);

      const message = String(error?.message || "").toLowerCase();
      const status = String(error?.status || error?.code || "");

      const retryable =
        ["429", "500", "502", "503", "504"].includes(status) ||
        [
          "unavailable",
          "rate limit",
          "temporarily unavailable",
          "timeout",
          "network"
        ].some(term => message.includes(term));

      if (!retryable || attempt === 4) {
        throw new Error(`Gemini analysis failed: ${error.message}`);
      }

      updateJob(jobId, {
        stage: "analysing",
        progress: 40,
        message: `Gemini is busy. Retrying (${attempt + 1}/4)...`
      });

      await sleep(waits[attempt - 1]);
    }
  }

  throw new Error("Gemini analysis could not be completed.");
}

async function analyseVideo(filePath, mimeType, jobId) {
  updateJob(jobId, {
    stage: "analysing",
    progress: 15,
    message: "Uploading video to Gemini..."
  });

  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType }
  });

  if (!uploaded.name) {
    throw new Error("Gemini did not provide a video reference.");
  }

  let file = uploaded;
  const startedAt = Date.now();

  while (true) {
    const state = String(file.state || "").toUpperCase();

    if (state.includes("ACTIVE")) break;

    if (state.includes("FAILED")) {
      throw new Error("Gemini could not process the video.");
    }

    if (Date.now() - startedAt > 5 * 60 * 1000) {
      throw new Error("Gemini video processing timed out.");
    }

    updateJob(jobId, {
      progress: 25,
      message: `Gemini is preparing the video: ${state || "PROCESSING"}`
    });

    await sleep(5000);
    file = await ai.files.get({ name: uploaded.name });
  }

  updateJob(jobId, {
    progress: 38,
    message: "Gemini is studying the scenes..."
  });

  const prompt = `
Analyse the supplied video as a professional video editor.

Select 2 to 6 useful scenes for a coherent movie recap.
Return scenes in chronological order.

For every scene provide:
- start: start time in seconds
- end: end time in seconds
- reason: why the scene matters
- description: factual description of what visibly happens

Rules:
- Never invent events.
- Describe visible actions clearly.
- Do not copy movie dialogue.
- Do not guess character names.
- Each clip must be 3 to 15 seconds.
- Total selected footage should be 20 to 55 seconds.
- Do not select repeated or unrelated moments.
- Keep the story understandable in chronological order.

Return ONLY JSON:
{
  "clips": [
    {
      "start": 10,
      "end": 18,
      "reason": "Why this scene matters",
      "description": "What visibly happens"
    }
  ]
}
`;

  const response = await generateContentWithRetry({
    model: GEMINI_MODEL,
    contents: [{
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
    }]
  }, jobId);

  const text = typeof response.text === "function"
    ? response.text()
    : response.text;

  const result = parseJSON(text, "Gemini");

  return {
    clips: validateClips(result.clips)
  };
}

async function writeNarration(clips, jobId) {
  updateJob(jobId, {
    stage: "writing",
    progress: 63,
    message: "Groq is writing your movie recap..."
  });

  const sceneNotes = clips.map((clip, index) => ({
    scene: index + 1,
    description: clip.description,
    importance: clip.reason,
    durationSeconds: Math.round(clip.end - clip.start)
  }));

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `
You are a skilled movie recap narrator.

Write clear, natural, engaging narration that explains the supplied scenes.

Rules:
- Follow the exact chronological order.
- Connect every scene naturally.
- Explain what is happening, not just what viewers can see.
- Use simple, conversational English.
- Do not use character names.
- Refer to people by descriptions or roles.
- Do not invent events, motives, or outcomes.
- Do not copy dialogue from the movie.
- Do not add a generic opening hook.
- Avoid robotic phrases and repetitive transitions.
- Make it sound like a human explaining a movie.
- Write approximately 85 to 115 words.
- Return only narration, without a title or notes.
`
          },
          {
            role: "user",
            content: JSON.stringify(sceneNotes)
          }
        ],
        temperature: 0.7,
        max_completion_tokens: 500
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();
    console.error("GROQ ERROR:", details);
    throw new Error(
      `Groq narration failed (${response.status}). Check your Groq model and API key.`
    );
  }

  const data = await response.json();
  const narration = data?.choices?.[0]?.message?.content?.trim();

  if (!narration || narration.length < 30) {
    throw new Error("Groq did not produce a usable narration.");
  }

  return narration;
}

async function generateVoice(narration, outputPath, jobId) {
  updateJob(jobId, {
    stage: "voicing",
    progress: 70,
    message: "Gemini is generating your narrator voice..."
  });

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GEMINI_TTS_MODEL,
        input: [{
          type: "user_input",
          content: [{
            type: "text",
            text: narration,
            annotations: [{
              type: "speech_metadata",
              style: "Natural, conversational movie recap narrator. "
                + "Engaging and expressive, clear pronunciation, "
                + "medium pace, confident storytelling."
            }]
          }]
        }],
        response_format: {
          type: "audio"
        },
        generation_config: {
          speech_config: [
            { voice: GEMINI_TTS_VOICE }
          ]
        }
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();
    console.error("GEMINI TTS ERROR:", details);

    throw new Error(
      `Gemini voice generation failed (${response.status}). Check Gemini TTS access or quota.`
    );
  }

  const data = await response.json();

  let audioBase64 = data?.output_audio?.data;

  if (!audioBase64 && Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      if (step?.type !== "model_output") continue;

      for (const content of step.content || []) {
        if (content?.type === "audio" && content?.data) {
          audioBase64 = content.data;
        }
      }
    }
  }

  if (!audioBase64) {
    console.error(
      "GEMINI TTS RESPONSE:",
      JSON.stringify(data).slice(0, 2000)
    );
    throw new Error("Gemini did not return audio data.");
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");

  if (audioBuffer.length < 1000) {
    throw new Error("Gemini returned an invalid audio file.");
  }

  await fs.promises.writeFile(outputPath, audioBuffer);
  return outputPath;
}

async function renderSilentVideo(inputPath, clips, outputPath, jobId) {
  const directory = path.dirname(outputPath);
  const clipFiles = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const clipPath = path.join(directory, `clip-${i}.mp4`);

    updateJob(jobId, {
      stage: "rendering",
      progress: 75 + Math.floor((i / clips.length) * 12),
      message: `Rendering selected scene ${i + 1} of ${clips.length}...`
    });

    await runCommand(ffmpegPath, [
      "-y",
      "-ss", String(clip.start),
      "-i", inputPath,
      "-t", String(clip.end - clip.start),
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

  const listPath = path.join(directory, "clips.txt");

  fs.writeFileSync(
    listPath,
    clipFiles.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join("\n")
  );

  updateJob(jobId, {
    progress: 88,
    message: "Joining selected scenes..."
  });

  await runCommand(ffmpegPath, [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath
  ]);
}

async function combineNarration(videoPath, audioPath, outputPath, jobId) {
  updateJob(jobId, {
    stage: "mixing",
    progress: 92,
    message: "Combining the video with AI narration..."
  });

  await runCommand(ffmpegPath, [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "160k",
    "-shortest",
    "-movflags", "+faststart",
    outputPath
  ]);
}

async function processVideo(jobId, buffer, mimeType, mode, manualClips) {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "reelnarrator-")
  );

  const inputPath = path.join(directory, "original-video.mp4");
  const silentPath = path.join(directory, "silent-short.mp4");
  const audioPath = path.join(directory, "narration.wav");
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

    let analysis;

    if (mode === "manual") {
      updateJob(jobId, {
        stage: "selecting",
        progress: 38,
        message: "Using your manually selected scenes..."
      });

      analysis = {
        clips: getManualClips(manualClips)
      };
    } else {
      analysis = await analyseVideo(inputPath, mimeType, jobId);
    }

    updateJob(jobId, {
      stage: "selecting",
      progress: 60,
      message: "Scenes selected. Preparing your recap...",
      clips: analysis.clips
    });

    const narration = await writeNarration(analysis.clips, jobId);

    await generateVoice(narration, audioPath, jobId);

    await renderSilentVideo(
      inputPath,
      analysis.clips,
      silentPath,
      jobId
    );

    await combineNarration(
      silentPath,
      audioPath,
      outputPath,
      jobId
    );

    await runCommand(ffmpegPath, [
      "-v", "error",
      "-i", outputPath,
      "-f", "null",
      "-"
    ]);

    const stats = await fs.promises.stat(outputPath);

    if (!stats.isFile() || stats.size < 1000) {
      throw new Error("The finished video file is invalid.");
    }

    updateJob(jobId, {
      stage: "ready",
      progress: 100,
      message: "Your video with AI narration is ready.",
      result: {
        videoUrl: `/api/video/${jobId}`,
        downloadUrl: `/api/download/${jobId}`,
        clips: analysis.clips,
        narration,
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
      error: "Finished video is no longer available. Please create it again."
    });
  }

  const outputPath = path.join(job.directory, "finished-short.mp4");

  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({
      error: "Video file is missing. Please create it again."
    });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");

  if (download) {
    return res.download(outputPath, "reelnarrator-short.mp4");
  }

  return res.sendFile(outputPath);
}

app.post("/api/create-short", (req, res) => {
  upload.single("movie")(req, res, error => {
    if (error) {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }

    if (!ai) {
      return res.status(500).json({
        ok: false,
        error: "GEMINI_API_KEY is missing. It is still needed for voice generation."
      });
    }

    if (!GROQ_KEY) {
      return res.status(500).json({
        ok: false,
        error: "GROQ_API_KEY is missing."
      });
    }

    if (!ffmpegPath) {
      return res.status(500).json({
        ok: false,
        error: "FFmpeg is not available."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Please select a video."
      });
    }

    const mode = req.body.mode === "manual" ? "manual" : "auto";

    if (mode === "manual") {
      try {
        getManualClips(req.body.manualClips);
      } catch (validationError) {
        return res.status(400).json({
          ok: false,
          error: validationError.message
        });
      }
    }

    const id = crypto.randomUUID();

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

    processVideo(
      id,
      req.file.buffer,
      req.file.mimetype,
      mode,
      req.body.manualClips
    );
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "ReelNarrator",
    editor: "AI-analysis-manual-scene-selection-recap-writing-and-voice-rendering",
    geminiConfigured: Boolean(GEMINI_KEY),
    geminiTtsConfigured: Boolean(GEMINI_KEY),
    geminiTtsModel: GEMINI_TTS_MODEL,
    geminiTtsVoice: GEMINI_TTS_VOICE,
    groqConfigured: Boolean(GROQ_KEY),
    ffmpegConfigured: Boolean(ffmpegPath)
  });
});

setInterval(async () => {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    const updatedAt = Number(job.updatedAt || job.createdAt || now);

    if (now - updatedAt < JOB_TTL_MS) continue;
    if (job.stage !== "ready" && job.stage !== "error") continue;

    jobs.delete(id);

    if (job.directory) {
      await fs.promises.rm(job.director
