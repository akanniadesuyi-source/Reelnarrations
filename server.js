
import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const maxMb = Number(process.env.MAX_UPLOAD_MB || 100);

// Find the public folder relative to this server.js file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, "public");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Please upload a video file."));
    }
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicPath));

function getAI() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
}

function narrationPrompt(extra = "") {
  return `You are a careful movie-scene narrator. Create an original, coherent recap narration based only on the supplied video.

Follow the scene order. Do not invent events, dialogue, motivations, or details that are not visible or reasonably clear.

Use simple, natural English, short sentences, and smooth transitions. Do not use character names; identify people by clear descriptions where possible.

Do not reproduce the film's dialogue or screenplay. Summarize events in your own words.

Return only the narration script, with no title or notes.

${extra}`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ReelNarrator" });
});

// Upload a video
app.post("/api/narrate-upload", upload.single("movie"), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        error: "Gemini API key is not configured on the server yet."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Choose a video file first."
      });
    }

    const ai = getAI();

    const blob = new Blob([req.file.buffer], {
      type: req.file.mimetype
    });

    const uploaded = await ai.files.upload({
      file: blob,
      config: { mimeType: req.file.mimetype }
    });

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          fileData: {
            fileUri: uploaded.uri,
            mimeType: req.file.mimetype
          }
        },
        {
          text: narrationPrompt(
            "Create a detailed recap suitable for YouTube narration. Keep it chronological."
          )
        }
      ]
    });

    res.json({
      script: result.text || "The model returned no narration."
    });

  } catch (err) {
    console.error("Upload narration error:", err);

    res.status(500).json({
      error: err.message || "Could not analyse this video."
    });
  }
});

// Analyse a public YouTube link
app.post("/api/narrate-youtube", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        error: "Gemini API key is not configured on the server yet."
      });
    }

    const url = String(req.body?.url || "").trim();

    if (
      !/^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{6,}/.test(url)
    ) {
      return res.status(400).json({
        error: "Enter a valid public YouTube video URL."
      });
    }

    const ai = getAI();

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          fileData: {
            fileUri: url,
            mimeType: "video/mp4"
          }
        },
        {
          text: narrationPrompt(
            "Create a detailed recap suitable for YouTube narration. Keep it chronological."
          )
        }
      ]
    });

    res.json({
      script: result.text || "The model returned no narration."
    });

  } catch (err) {
    console.error("YouTube narration error:", err);

    res.status(500).json({
      error: err.message ||
        "Could not analyse this YouTube video. It may be unsupported or unavailable to Gemini."
    });
  }
});

// Generate voice with ElevenLabs
app.post("/api/voice", async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({
        error: "ElevenLabs API key is not configured on the server yet."
      });
    }

    const text = String(req.body?.text || "").trim();
    const voiceId = String(
      req.body?.voiceId || "21m00Tcm4TlvDq8ikWAM"
    );

    if (!text) {
      return res.status(400).json({
        error: "Write or generate a narration first."
      });
    }

    if (text.length > 12000) {
      return res.status(400).json({
        error: "This version accepts up to 12,000 characters per voice generation."
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
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.48,
            similarity_boost: 0.78
          }
        })
      }
    );

    if (!response.ok) {
      const detail = await response.text();

      return res.status(response.status).json({
        error: `ElevenLabs error: ${detail.slice(0, 500)}`
      });
    }

    const audio = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="reelnarrator.mp3"'
    );

    res.send(audio);

  } catch (err) {
    console.error("Voice generation error:", err);

    res.status(500).json({
      error: err.message || "Could not generate voice."
    });
  }
});

// Handle errors
app.use((err, _req, res, _next) => {
  if (
    err instanceof multer.MulterError &&
    err.code === "LIMIT_FILE_SIZE"
  ) {
    return res.status(413).json({
      error: `Video is too large. Current upload limit is ${maxMb} MB.`
    });
  }

  res.status(400).json({
    error: err.message || "Request failed."
  });
});

app.listen(port, () => {
  console.log(`ReelNarrator running on port ${port}`);
});
                             
