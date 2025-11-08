import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "..", "uploads");
const dataDir = path.join(__dirname, "..", "data");
const dataFile = path.join(dataDir, "jobs.json");

// Ensure dirs exist
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeName =
      Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    if (
      !file.mimetype.startsWith("image/") &&
      !file.mimetype.startsWith("video/")
    ) {
      return cb(new Error("Only images and videos allowed"));
    }
    cb(null, true);
  }
});

// Helpers
function loadJobs() {
  if (!fs.existsSync(dataFile)) return [];
  try {
    const raw = fs.readFileSync(dataFile, "utf-8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("Error reading jobs file:", e);
    return [];
  }
}

function saveJobs(jobs) {
  try {
    fs.writeFileSync(dataFile, JSON.stringify(jobs, null, 2));
  } catch (e) {
    console.error("Error writing jobs file:", e);
  }
}

// OpenAI client (uses your env on Render)
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      project: process.env.OPENAI_PROJECT_ID || undefined
    })
  : null;

// POST /api/jobs/upload
router.post("/upload", upload.single("media"), async (req, res) => {
  try {
    const {
      price,
      description,
      scopeType = "snapshot",
      operatorId = "demo-operator"
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Media file is required." });
    }
    if (!price || !description) {
      return res
        .status(400)
        .json({ error: "Price and description are required." });
    }

    const numericPrice = Number(price);
    if (!numericPrice || Number.isNaN(numericPrice) || numericPrice <= 0) {
      return res
        .status(400)
        .json({ error: "Price must be a positive number." });
    }

    const safeScope =
      scopeType === "walkaround" ? "walkaround" : "snapshot";

    let aiLow, aiHigh, upsellPotential, notes;

    // 1) Contextual band from OpenAI
    if (openai) {
      try {
        const userPrompt = `
You are WorkAI, a disciplined pricing assistant for small service contractors.

Given:
- Job description: """${description.trim()}"""
- Price charged (USD): ${numericPrice}
- Scope type: ${safeScope}
- Operator: small / owner-operator

Your job:
- Suggest a fair price band around their number.
- Respect effort, risk, and value. Do NOT race to the bottom.
- If clearly underpriced for effort, raise upsellPotential.
- If strong/premium, confirm confidence; don't shame.

Return ONLY valid JSON:
{
  "aiLow": number,
  "aiHigh": number,
  "upsellPotential": number,
  "notes": string
}
No extra fields. No extra text.
`;

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are WorkAI, a B2B pricing assistant. Always reply with STRICT JSON exactly in the requested schema."
            },
            { role: "user", content: userPrompt }
          ]
        });

        const content = completion.choices?.[0]?.message?.content || "{}";
        const parsed = JSON.parse(content);

        aiLow = Number(parsed.aiLow);
        aiHigh = Number(parsed.aiHigh);
        upsellPotential = Number(parsed.upsellPotential);
        notes =
          typeof parsed.notes === "string" ? parsed.notes.trim() : "";
      } catch (err) {
        console.error("OpenAI error, using fallback:", err);
      }
    }

    // 2) Fallback if AI fails or nonsense band
    if (!aiLow || !aiHigh || aiHigh <= aiLow) {
      const spread = Math.max(25, Math.round(numericPrice * 0.12));
      aiLow = Math.max(1, numericPrice - spread);
      aiHigh = numericPrice + spread;
    }

    if (!upsellPotential || upsellPotential < 0 || upsellPotential > 100) {
      const headroom = Math.max(0, aiHigh - numericPrice);
      const pct =
        numericPrice > 0
          ? Math.round((headroom / numericPrice) * 100)
          : 0;
      upsellPotential = Math.max(5, Math.min(40, pct || 15));
    }

    if (!notes) {
      notes =
        "Based on your description, this sits in a fair band for your effort. Lead with outcome and reliability, not discounts.";
    }

    // 3) History-based tuning: align band width with THEIR pattern
    const jobsHistory = loadJobs();
    const similar = jobsHistory.filter((j) => j.scopeType === safeScope);

    if (similar.length >= 5) {
      const spreads = similar
        .map((j) => {
          if (!j.price || !j.aiLow || !j.aiHigh) return null;
          const width = j.aiHigh - j.aiLow;
          if (width <= 0) return null;
          return width / j.price; // relative width
        })
        .filter((v) => v && v > 0 && v < 1.5); // ditch trash

      if (spreads.length >= 3) {
        const sorted = spreads.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianSpread =
          sorted.length % 2
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;

        const width = Math.max(0.15, Math.min(0.45, medianSpread));
        const center = numericPrice;

        const tunedLow = Math.round(center * (1 - width / 2));
        const tunedHigh = Math.round(center * (1 + width / 2));

        if (tunedLow > 0 && tunedHigh > tunedLow) {
          aiLow = tunedLow;
          aiHigh = tunedHigh;
        }
      }
    }

    // 4) Stress-test shield: don't look dumb on flex / troll inputs
    const highRatio = numericPrice / aiHigh;
    const lowRatio = numericPrice / aiLow;

    if (highRatio >= 1.35) {
      // Way above band → assume intentional premium/test
      aiLow = Math.round(numericPrice * 0.9);
      aiHigh = Math.round(numericPrice * 1.05);
      upsellPotential = 0;
      notes =
        "You're already sitting at the top end for this kind of job. No upsell suggested—just make sure your delivery matches the ticket.";
    } else if (lowRatio <= 0.65) {
      // Clearly under band → real room to move
      const headroom = Math.max(0, aiHigh - numericPrice);
      const pct =
        numericPrice > 0
          ? Math.round((headroom / numericPrice) * 100)
          : 30;

      upsellPotential = Math.max(25, Math.min(60, pct || 30));
      notes =
        "You're running this lean for the effort you described. You've got real room to bring this up with a clear scope and value story.";
    }

    // 5) Save final job + respond
    const jobEntry = {
      id: Date.now(),
      file: req.file.filename,
      operatorId,
      price: numericPrice,
      description: description.trim(),
      scopeType: safeScope,
      aiLow,
      aiHigh,
      upsellPotential,
      notes,
      createdAt: new Date().toISOString()
    };

    jobsHistory.push(jobEntry);
    saveJobs(jobsHistory);

    res.json(jobEntry);
  } catch (err) {
    console.error("Upload handler error:", err);
    res.status(500).json({ error: "Error generating Smart Report." });
  }
});

// GET /api/jobs/list
router.get("/list", (req, res) => {
  const jobs = loadJobs();
  res.json(jobs);
});

export default router;
