import express from "express";
import cors from "cors";
import jobsRouter from "./routes/jobs.js";

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ WorkAI backend running. Use /api/jobs/upload and /api/jobs/list");
});

app.use("/api/jobs", jobsRouter);

app.listen(port, () => {
  console.log(`🚀 WorkAI backend on port ${port}`);
});
