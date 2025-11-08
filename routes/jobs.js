import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "..", "uploads");
const dataFile = path.join(__dirname, "..", "data", "jobs.json");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeName = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    cb(null, safeName);
  }
});

const upload = multer({ storage });

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

router.post("/upload", upload.single("media"), (req, res) => {
  const { price, description, scopeType } = req.body;

  if (!req.file || !price || !description) {
    return res.status(400).json({ error: "Missing required fields (media, price, description)." });
  }

  const numericPrice = Number(price);
  const safeScope = scopeType === "walkaround" ? "walkaround" : "snapshot";

  const aiLow = Math.max(20, Math.round(numericPrice * 0.9));
  const aiHigh = Math.round(numericPrice * 1.15);
  const upsellPotential = Math.min(40, Math.max(5, Math.round((aiHigh - numericPrice) / (numericPrice || 1) * 100)));
  const notes = "Based on your price and this sample, you likely have room to position premium value via speed, quality, and reliability.";

  const jobs = loadJobs();
  const jobEntry = {
    id: Date.now(),
    file: req.file.filename,
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

  res.json({ aiLow, aiHigh, upsellPotential, notes });
});

router.get("/list", (req, res) => {
  const jobs = loadJobs();
  res.json(jobs);
});

export default router;
