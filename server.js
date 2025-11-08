import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import jobsRouter from "./routes/jobs.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

app.use("/api/jobs", jobsRouter);

app.get("/", (req, res) => {
  res.send("✅ WorkAI backend running. Use /api/jobs/upload and /api/jobs/list");
});

app.listen(PORT, () => {
  console.log(`🚀 WorkAI backend live on port ${PORT}`);
});
