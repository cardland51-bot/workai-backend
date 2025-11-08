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

// ensure dirs exist
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// multer storage
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

// helpers
function loadJobs() {
  if (!fs.existsSync(dataFile)) return [];
  try {
    const raw = fs.readFileSync(dataFile, "utf-8");
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  fs.writeFileSync(dataFile, JSON.stringify(jobs, null, 2));
}

// OpenAI client (uses your env vars already set on Render)
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

    // Use OpenAI if configured
    if (openai) {
      try {
        const userPrompt = `
You are WorkAI, a disciplined pricing assistant for small service contractors.

Given:
- Job description: """${description.trim()}"""
- Price charged (USD): ${numericPrice}
- Scope type: ${safeScope}
- Operator type: small/owner-operator

Your job:
- Suggest a fair price band around their number.
- Respect their time, risk, and value. Do NOT race to the bottom.
- If their price seems low for the effort, increase upsellPotential.
- If their price is solid, confirm confidence and keep upsellPotential modest.

Return ONLY valid JSON with this exact shape:
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
                "You are WorkAI, a B2B pricing assistant. Always reply with strict JSON exactly matching the requested schema."
            },
            { role: "user", content: userPrompt }
          ]
        });

        const raw = completion.choices?.[0]?.message?.content || "{}";
        const parsed = JSON.parse(raw);

        aiLow = Number(parsed.aiLow);
        aiHigh = Number(parsed.aiHigh);
        upsellPotential = Number(parsed.upsellPotential);
        notes =
          typeof parsed.notes === "string" ? parsed.notes.trim() : "";
      } catch (err) {
        console.error("OpenAI error, using fallback:", err?.message || err);
      }
    }

    // Fallback / sanity checks so we NEVER send garbage
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

    // Save job
    const jobs = loadJobs();
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
    jobs.push(jobEntry);
    saveJobs(jobs);

    // Return to frontend
    res.json(jobEntry);
  } catch (err) {
    console.error("Upload handler error:", err);
    res
      .status(500)
      .json({ error: "Error generating Smart Report." });
  }
});

// GET /api/jobs/list
router.get("/list", (req, res) => {
  const jobs = loadJobs();
  res.json(jobs);
});

export default router;
