// server.js (WorkAI v1 backend, tightened)
// Real band, bullshit guardrails, screenshot-safe output.

import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

// ---- OpenAI client ----
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  project: process.env.OPENAI_PROJECT_ID || undefined,
});

// ---- Storage paths ----
const uploadsDir = path.join(__dirname, "uploads");
const dataDir = path.join(__dirname, "data");
const jobsFile = path.join(dataDir, "jobs.json");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(jobsFile)) fs.writeFileSync(jobsFile, "[]", "utf-8");

// ---- Multer ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
    cb(null, Date.now() + "-" + safe);
  },
});
const upload = multer({ storage });

// ---- Helpers ----

function loadJobs() {
  try {
    const raw = fs.readFileSync(jobsFile, "utf-8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("Error reading jobs file:", e);
    return [];
  }
}

function saveJobs(jobs) {
  try {
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2), "utf-8");
  } catch (e) {
    console.error("Error writing jobs file:", e);
  }
}

// Try to infer duration from text: "1 hr", "2 hours", "30 min", etc.
function getApproxHours(desc = "") {
  const s = desc.toLowerCase();

  // Hours like "1 hr", "2hrs", "3 hours"
  const hrMatch = s.match(/(\d+(\.\d+)?)\s*(hr|hrs|hour|hours)\b/);
  if (hrMatch) {
    return parseFloat(hrMatch[1]);
  }

  // Minutes like "30 min", "45 minutes"
  const minMatch = s.match(/(\d+(\.\d+)?)\s*(min|mins|minute|minutes)\b/);
  if (minMatch) {
    const mins = parseFloat(minMatch[1]);
    if (!isNaN(mins) && mins > 0) {
      return mins / 60;
    }
  }

  return null; // unknown
}

// Tiny job clues
function looksLikeTinyJob(desc = "") {
  const s = desc.toLowerCase();
  return (
    s.includes("1 min") ||
    s.includes("1-min") ||
    s.includes("one minute") ||
    s.includes("5 min") ||
    s.includes("5-min") ||
    s.includes("five minutes") ||
    s.includes("tiny") ||
    s.includes("quick touch") ||
    s.includes("quick stop") ||
    s.includes("1 hr") || // we’ll combine with crazy price check
    s.includes("1hr")
  );
}

// ---- Core band logic with sanity checks ----

function buildSmartBand({ priceRaw, description, scopeType }) {
  const price = Number(priceRaw) || 0;
  const desc = (description || "").trim();
  const scope = scopeType || "snapshot";

  if (!price || price <= 0) {
    return {
      price: 0,
      scopeType: scope,
      description: desc,
      aiLow: 0,
      aiHigh: 0,
      upsellPotential: 0,
      notes:
        "No price provided. Use real jobs with real numbers to get a useful band.",
    };
  }

  // Base: ±25% around their number
  let aiLow = Math.round(price * 0.75);
  let aiHigh = Math.round(price * 1.25);

  // Never embarrass: clamp extremes
  if (aiLow < Math.round(price * 0.5)) aiLow = Math.round(price * 0.5);
  if (aiHigh > Math.round(price * 1.6)) aiHigh = Math.round(price * 1.6);

  let upsellPotential = 15;
  let notes =
    "You’re in a workable lane. If your communication and finish are strong, you can test the upper side of this band.";

  const hours = getApproxHours(desc);
  let hourly = null;
  if (hours && hours > 0) {
    hourly = price / hours;
  }

  // Case 1: tiny / very short job with crazy price → you're at ceiling
  if ((looksLikeTinyJob(desc) || (hours && hours <= 0.25)) && price >= 400) {
    aiLow = Math.round(price * 0.8);
    aiHigh = Math.round(price * 1.0);
    upsellPotential = 0;
    notes =
      "This looks like a very small scope at a high rate. You’re already at the ceiling; only hold this if your speed, reliability, and presentation clearly back it up. No upsell recommended.";
  }

  // Case 2: explicit hourly insanity (e.g. 30k for 1 hr)
  if (hourly && hourly > 1000) {
    // Pull band down slightly, never cheerlead.
    aiLow = Math.round(price * 0.6);
    aiHigh = Math.round(price * 0.9);
    if (aiHigh < aiLow) aiHigh = aiLow;
    upsellPotential = 0;
    notes =
      "This implied hourly rate is extremely high for most markets. Treat this as a special-case or adjust toward the lower side of this band if you want to maintain trust.";
  }

  // Case 3: generic large ticket: no auto-upsell
  if (price >= 2000 && (!hourly || hourly <= 1000)) {
    upsellPotential = 0;
    if (!notes || notes.startsWith("You’re in a workable lane")) {
      notes =
        "For higher-ticket work, stay inside this band unless you’re clearly offering premium design, warranty, or speed.";
    }
  }

  // Global caps
  if (upsellPotential > 40) upsellPotential = 40;
  if (upsellPotential < 0) upsellPotential = 0;

  return {
    price,
    scopeType: scope,
    description: desc,
    aiLow,
    aiHigh,
    upsellPotential,
    notes,
    hourly: hourly || null, // just for our own debugging if needed
  };
}

// ---- App ----

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "workai-backend", status: "alive" });
});

// List jobs
app.get("/api/jobs/list", (req, res) => {
  const jobs = loadJobs();
  res.json(jobs);
});

// Upload job + media → Smart Report
app.post("/api/jobs/upload", upload.single("media"), async (req, res) => {
  try {
    const { price, description, scopeType } = req.body;

    // 1) Deterministic band + guardrails
    let baseJob = buildSmartBand({ priceRaw: price, description, scopeType });

    // 2) Attach basic media info
    if (req.file) {
      baseJob.media = {
        filename: req.file.filename,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      };
    }

    // 3) Optional: refine notes via OpenAI (but NO clown takes)
    if (process.env.OPENAI_API_KEY) {
      try {
        const summary = `
Operator job:
- Scope: ${baseJob.scopeType}
- Description: ${baseJob.description || "n/a"}
- Operator price: $${baseJob.price}
- Suggested band (fixed): $${baseJob.aiLow} - $${baseJob.aiHigh}
- UpsellPotential (0-40): ${baseJob.upsellPotential}%
- ImpliedHourly (if provided): ${baseJob.hourly || "n/a"}

Write 2–4 short sentences as a pricing coach for an independent operator.

Hard rules:
- DO NOT contradict the band numbers given.
- If the implied hourly rate is extremely high (e.g. > $1000/hr) or description sounds very small vs. price, you MUST say it's at/above ceiling, advise caution, and do NOT praise it as "balanced".
- No "you could charge way more" hype. No coupons. No race-to-the-bottom either.
- Output must be screenshot-safe: if a customer reads it, it should feel fair, grounded, and respectful.
`;

        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content:
                "You are a grounded pricing coach for blue-collar operators. You protect trust. You never sound like a hype mascot or encourage obvious gouging.",
            },
            { role: "user", content: summary },
          ],
          max_tokens: 200,
        });

        const aiText =
          completion.choices?.[0]?.message?.content?.trim() || "";

        if (aiText) {
          baseJob.notes = aiText;
        }
      } catch (err) {
        console.warn("OpenAI refinement failed, using baseline notes.", err);
      }
    }

    // 4) Persist
    const jobs = loadJobs();
    const id = Date.now().toString();
    const savedJob = {
      id,
      createdAt: new Date().toISOString(),
      ...baseJob,
    };
    jobs.push(savedJob);
    saveJobs(jobs);

    // 5) Return
    res.json(savedJob);
  } catch (err) {
    console.error("Upload handler error:", err);
    res
      .status(500)
      .json({ error: "Backend error while building your ticket." });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`WorkAI backend listening on port ${PORT}`);
});
