import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const maxMb = Number(process.env.MAX_UPLOAD_MB || 100);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("Please upload a video file."));
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Gemini API key is not configured.");
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function narrationPrompt() {
  return `You are a careful movie-scene narrator. Create an original, coherent recap narration based only on the supplied video.

Follow the scene order. Do not invent events or details.
Use simple, natural English and short sentences.
Do not use character names; identify people by descriptions.
Do not reproduce the film's dialogue or screenplay.
Return only the narration script, with no title or notes.`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ReelNarrator" });
});

app.post("/api/narrate-upload", upload.single("movie"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Choose a video first." });
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
          text: narrationPrompt()
        }
      ]
    });

    res.json({ script: result.text || "No narration returned." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/narrate-youtube", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();

    if (!/^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{6,}/.test(url)) {
      return res.status(400).json({ error: "Enter a valid public YouTube URL." });
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
          text: narrationPrompt()
        }
      ]
    });

    res.json({ script: result.text || "No narration returned." });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || "Could not analyse this YouTube video."
    });
  }
});

app.post("/api/voice", async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({
        error: "ElevenLabs API key is not configured."
      });
    }

    const text = String(req.body?.text || "").trim();
    const voiceId = "21m00Tcm4TlvDq8ikWAM";

    if (!text) {
      return res.status(400).json({ error: "Write a script first." });
    }

    if (text.length > 12000) {
      return res.status(400).json({
        error: "Maximum 12,000 characters per voice generation."
      });
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
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
      return res.status(response.status).json({
        error: "ElevenLabs could not generate the voice."
      });
    }

    const audio = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audio);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  res.status(400).json({
    error: err.message || "Request failed."
  });
});

app.listen(port, () => {
  console.log(`ReelNarrator running on port ${port}`);
});
      
