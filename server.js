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

// ---- OpenAI client (optional but recommended) ----
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  project: process.env.OPENAI_PROJECT_ID || undefined,
});

// ---- Storage setup ----
const uploadsDir = path.join(__dirname, "uploads");
const dataDir = path.join(__dirname, "data");
const jobsFile = path.join(dataDir, "jobs.json");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(jobsFile)) fs.writeFileSync(jobsFile, "[]", "utf-8");

// Multer storage: keep it simple & safe
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

// Tiny helper: spot “tiny job, huge price” patterns from text
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
    s.includes("quick stop")
  );
}

// ---- Core band logic ----

function buildSmartBand({ priceRaw, description, scopeType }) {
  const price = Number(priceRaw) || 0;
  const desc = (description || "").trim();
  const scope = scopeType || "snapshot";

  // Default if price is junk
  if (!price || price <= 0) {
    return {
      price: 0,
      scopeType: scope,
      description: desc,
      aiLow: 0,
      aiHigh: 0,
      upsellPotential: 0,
      notes:
        "No price provided. Use this tool on real jobs with real numbers to get a useful band.",
    };
  }

  // Base band around their number (realistic but forgiving)
  let aiLow = Math.round(price * 0.75);
  let aiHigh = Math.round(price * 1.25);

  // Hard sanity clamps so we never embarrass them:
  // - Don’t say less than half
  // - Don’t say more than ~1.6x without a reason
  if (aiLow < Math.round(price * 0.5)) aiLow = Math.round(price * 0.5);
  if (aiHigh > Math.round(price * 1.6)) aiHigh = Math.round(price * 1.6);

  // Base upsellPotential
  let upsellPotential = 15; // gentle signal, not hype
  let notes =
    "You’re in a workable lane. If your communication and finish quality are strong, you can test the upper side of this band.";

  // Tiny job + huge price? Flip to “you’re already maxed”.
  if (looksLikeTinyJob(desc) && price >= 400) {
    aiLow = Math.round(price * 0.8);
    aiHigh = Math.round(price * 1.05);
    upsellPotential = 0;
    notes =
      "This is already an aggressive rate for a very small scope. Hold this only if your speed, reliability, and presentation clearly back it up. No upsell recommended.";
  }

  // Extremely high prices in general: cap upsell.
  if (price >= 2000) {
    upsellPotential = 0;
    if (!looksLikeTinyJob(desc)) {
      notes =
        "For higher-ticket work, stay inside this band unless you’re offering clearly premium design, warranty, or speed. No blind upsell.";
    }
  }

  // Global cap on upsell, ever.
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
  };
}

// ---- App ----

const app = express();
app.use(cors());
app.use(express.json());

// Simple health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "workai-backend", status: "alive" });
});

// List jobs (for deck)
app.get("/api/jobs/list", (req, res) => {
  const jobs = loadJobs();
  res.json(jobs);
});

// Upload job + media → Smart Report
app.post(
  "/api/jobs/upload",
  upload.single("media"),
  async (req, res) => {
    try {
      const { price, description, scopeType } = req.body;

      // 1) Core deterministic band
      let job = buildSmartBand({ priceRaw: price, description, scopeType });

      // Attach basic media info (no heavy lifting yet)
      if (req.file) {
        job.media = {
          filename: req.file.filename,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
        };
      }

      // 2) Optional: refine notes with OpenAI (but never let it go clown mode)
      try {
        if (process.env.OPENAI_API_KEY) {
          const summary = `
Operator job:
- Scope: ${job.scopeType}
- Description: ${job.description || "n/a"}
- Operator price: $${job.price}
- Suggested band (internal): $${job.aiLow} - $${job.aiHigh}
- UpsellPotential (0-40, internal): ${job.upsellPotential}%

Write 2–4 short, plain-English sentences as a pricing coach for a blue-collar independent operator.
Rules:
- No coupons. No race to the bottom.
- Do NOT tell them to massively raise an obviously extreme tiny-job price.
- If their number is already at the ceiling, say so directly and advise stability.
- Keep it screenshot-safe: if they show this to a customer, it should sound fair, not greasy.
- Do not exceed the given band. Do not change the band numbers.
`;

          const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are a grounded pricing coach for home service operators. You protect trust. You never sound like a hype SaaS mascot.",
              },
              { role: "user", content: summary },
            ],
            max_tokens: 160,
          });

          const aiText =
            completion.choices?.[0]?.message?.content?.trim() || "";

          if (aiText) {
            job.notes = aiText;
          }
        }
      } catch (err) {
        console.warn("OpenAI refinement failed, using baseline notes.", err);
      }

      // 3) Persist job
      const jobs = loadJobs();
      const id = Date.now().toString();
      const savedJob = { id, createdAt: new Date().toISOString(), ...job };
      jobs.push(savedJob);
      saveJobs(jobs);

      // 4) Return for frontend card
      res.json(savedJob);
    } catch (err) {
      console.error("Upload handler error:", err);
      res.status(500).json({
        error: "Something broke on the backend while building your ticket.",
      });
    }
  }
);

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`WorkAI backend listening on port ${PORT}`);
});
