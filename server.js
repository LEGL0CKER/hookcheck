const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// --- very simple per-IP daily limit (v1; move to Supabase later) ---
const usage = new Map();
const DAILY_LIMIT = 5;
function underLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const key = ip + "|" + today;
  const count = usage.get(key) || 0;
  if (count >= DAILY_LIMIT) return false;
  usage.set(key, count + 1);
  return true;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function getDuration(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const dur = parseFloat(out.trim());
  if (!isFinite(dur) || dur <= 0) throw new Error("Couldn't read video duration.");
  return dur;
}

function targetTimes(dur) {
  const times = [0.1, 0.6, 1.2, 2.0, dur * 0.4, dur * 0.7, Math.max(dur - 0.4, 0.2)];
  return [...new Set(times.filter((t) => t >= 0 && t < dur).map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
}

async function extractFrame(file, time, outPath) {
  // ffmpeg decodes HEVC, H.264, VP9, AV1 — no client codec problems, ever
  await run("ffmpeg", [
    "-ss", String(time),
    "-i", file,
    "-frames:v", "1",
    "-vf", "scale=480:-2",
    "-q:v", "6",
    "-y", outPath,
  ]);
  return fs.readFileSync(outPath).toString("base64");
}

function buildPrompt(duration, niche, plannedCaption) {
  return `You are a short-form video strategist who has studied thousands of TikTok videos. Above are frames sampled from a ${duration.toFixed(1)}-second video. The first 3-4 frames cover the hook (first 2 seconds), the rest show pacing through the video.
${niche ? `Creator's niche: ${niche}.` : ""}
${plannedCaption ? `Their planned caption: "${plannedCaption}".` : ""}

Grade this video like a coach before the creator posts it. Be direct and specific — reference what you actually see in the frames. Judge the hook hard: would a stranger stop scrolling in the first second?

Respond with ONLY a JSON object, no markdown fences, no preamble:
{
  "overallScore": <0-100>,
  "hookScore": <0-100>,
  "hook": { "verdict": "<1-2 sentence honest read of the first 2 seconds>", "fix": "<one specific change>" },
  "pacing": { "verdict": "<1-2 sentences on visual variety and progression>", "fix": "<one specific change>" },
  "visual": { "verdict": "<1-2 sentences on framing, lighting, readability on a phone>", "fix": "<one specific change>" },
  "captions": ["<option 1>", "<option 2>", "<option 3>"],
  "hashtags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"],
  "postTime": "<best posting window for this niche and why, one sentence>",
  "flopRisks": ["<risk 1>", "<risk 2>"]
}`;
}

app.post("/api/grade", upload.single("video"), async (req, res) => {
  const tmpFiles = [];
  try {
    if (!API_KEY) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
    if (!req.file) return res.status(400).json({ error: "No video uploaded." });
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    if (!underLimit(ip)) return res.status(429).json({ error: `Daily free limit reached (${DAILY_LIMIT} grades). Come back tomorrow.` });

    const videoPath = req.file.path;
    tmpFiles.push(videoPath);

    const duration = await getDuration(videoPath);
    if (duration > 600) return res.status(400).json({ error: "Video is over 10 minutes — upload a short-form clip." });

    const times = targetTimes(duration);
    const content = [];
    for (const t of times) {
      const framePath = path.join(os.tmpdir(), `${req.file.filename}-${t}.jpg`);
      tmpFiles.push(framePath);
      const b64 = await extractFrame(videoPath, t, framePath);
      content.push({ type: "text", text: `Frame at ${t}s:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
    }
    content.push({ type: "text", text: buildPrompt(duration, req.body.niche || "", req.body.caption || "") });

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content }],
      }),
    });
    const data = await apiRes.json();
    if (data.error) throw new Error(data.error.message || "Claude API error");

    const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Analysis failed." });
  } finally {
    for (const f of tmpFiles) fs.unlink(f, () => {});
  }
});

app.listen(PORT, () => console.log(`HookCheck running on :${PORT}`));
