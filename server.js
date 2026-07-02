const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- model provider ---
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || (OPENROUTER_KEY ? "google/gemini-2.5-flash" : "claude-sonnet-4-6");

// --- supabase (optional: app runs in open mode without it) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH_ON = !!(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_KEY);

// --- stripe (optional) ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const APP_URL = process.env.APP_URL || "";
const stripe = STRIPE_KEY ? require("stripe")(STRIPE_KEY) : null;

const FREE_MONTHLY_LIMIT = 3;

// stripe webhook must get the raw body, so register it BEFORE static/json middleware
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send("Stripe not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook signature failed: ${e.message}`);
  }
  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const userId = s.client_reference_id;
      if (userId) await sbUpsertProfile(userId, { is_premium: true, stripe_customer_id: s.customer });
    }
    if (event.type === "customer.subscription.deleted") {
      const customerId = event.data.object.customer;
      await sbPatch(`profiles?stripe_customer_id=eq.${customerId}`, { is_premium: false });
    }
    res.json({ received: true });
  } catch (e) {
    console.error("webhook error", e);
    res.status(500).send("webhook handler failed");
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });

// ---------------- supabase helpers (REST, service role) ----------------
function sbHeaders() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json",
  };
}
async function sbGet(q) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: sbHeaders() });
  return r.json();
}
async function sbCount(q) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: { ...sbHeaders(), prefer: "count=exact", range: "0-0" } });
  const cr = r.headers.get("content-range") || "/0";
  return parseInt(cr.split("/")[1] || "0", 10);
}
async function sbInsert(table, row) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(row) });
}
async function sbPatch(q, patch) {
  await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { method: "PATCH", headers: sbHeaders(), body: JSON.stringify(patch) });
}
async function sbUpsertProfile(userId, fields) {
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
    method: "POST",
    headers: { ...sbHeaders(), prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: userId, ...fields }),
  });
}

// validate the user's supabase access token
async function getUser(req) {
  if (!AUTH_ON) return null;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function getProfile(userId) {
  const rows = await sbGet(`profiles?id=eq.${userId}&select=is_premium,stripe_customer_id`);
  return rows[0] || null;
}

function monthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// ---------------- ffmpeg helpers ----------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}
async function getDuration(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const dur = parseFloat(out.trim());
  if (!isFinite(dur) || dur <= 0) throw new Error("Couldn't read video duration.");
  return dur;
}
function targetTimes(dur) {
  const times = [0.1, 0.6, 1.2, 2.0, dur * 0.4, dur * 0.7, Math.max(dur - 0.4, 0.2)];
  return [...new Set(times.filter((t) => t >= 0 && t < dur).map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
}
async function extractFrame(file, time, outPath) {
  await run("ffmpeg", ["-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "6", "-y", outPath]);
  return fs.readFileSync(outPath).toString("base64");
}
async function extractAudio(file, outPath) {
  // first 12 seconds, mono, small — enough to judge the sound/voice hook
  try {
    await run("ffmpeg", ["-i", file, "-t", "12", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-y", outPath]);
    const b = fs.readFileSync(outPath);
    if (b.length < 1000) return null; // no real audio track
    return b.toString("base64");
  } catch {
    return null; // silent video or no audio stream
  }
}

// ---------------- the grader ----------------
function buildPrompt(duration, niche, plannedCaption, hasAudio) {
  return `You are a brutally honest short-form video coach. You have watched 10,000 TikToks and you know exactly why videos flop. Above are frames sampled from a ${duration.toFixed(1)}-second video (timestamps labeled — the first 3-4 frames are the hook window)${hasAudio ? ", plus the first 12 seconds of audio" : ""}.
${niche ? `Creator's niche: ${niche}.` : ""}
${plannedCaption ? `Their planned caption: "${plannedCaption}".` : ""}

CALIBRATION — follow this strictly:
- The average TikTok scores 45-55. Score honestly against ALL of TikTok, not against this creator's other videos.
- 80+ means you would genuinely stop scrolling as a stranger. This should be rare.
- A static opening shot (person standing, bike parked, setup shot) caps the hook score at 55 no matter what.
- Talking-head with no motion, text, or pattern interrupt in frame 1 caps the hook at 60.
- Do not give courtesy points. A D grade that is accurate helps the creator more than a B that is flattery.

RULES for feedback:
- Reference SPECIFIC things visible in the frames (objects, framing, lighting, text, motion blur). Generic advice like "add better lighting" is banned — say what is wrong with THIS video's lighting.
- Every fix must be something the creator can do in under 30 minutes with a phone.
${hasAudio ? "- Judge the audio hook: is there a voice, sound, or beat in the first 2 seconds that grabs attention? Silence or slow ambient noise is a flop risk." : ""}
- Captions must create curiosity or controversy, not describe the video.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{
  "overallScore": <0-100>,
  "hookScore": <0-100>,
  "hook": { "verdict": "<what actually happens in the first 2s and why it does/doesn't stop the scroll>", "fix": "<one specific change>" },
  ${hasAudio ? `"audioHook": { "verdict": "<what the audio does in the first 2s>", "fix": "<one specific change>" },` : ""}
  "pacing": { "verdict": "<1-2 sentences on visual variety and progression>", "fix": "<one specific change>" },
  "visual": { "verdict": "<1-2 sentences on framing, lighting, phone readability>", "fix": "<one specific change>" },
  "captions": ["<option 1>", "<option 2>", "<option 3>"],
  "hashtags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"],
  "postTime": "<best posting window for this niche and why, one sentence>",
  "flopRisks": ["<risk 1>", "<risk 2>"]
}`;
}

async function callOpenRouter(frames, audioB64, prompt) {
  const content = [];
  for (const f of frames) {
    content.push({ type: "text", text: `Frame at ${f.time}s:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.b64}` } });
  }
  if (audioB64) content.push({ type: "input_audio", input_audio: { data: audioB64, format: "mp3" } });
  content.push({ type: "text", text: prompt });
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENROUTER_KEY}`, "x-title": "HookCheck" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: "user", content }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "OpenRouter API error");
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(frames, prompt) {
  const content = [];
  for (const f of frames) {
    content.push({ type: "text", text: `Frame at ${f.time}s:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.b64 } });
  }
  content.push({ type: "text", text: prompt });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: "user", content }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Claude API error");
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

async function gradeWithModel(frames, audioB64, duration, niche, caption) {
  if (OPENROUTER_KEY) {
    if (audioB64) {
      try {
        return { text: await callOpenRouter(frames, audioB64, buildPrompt(duration, niche, caption, true)), audio: true };
      } catch (e) {
        console.warn("audio grading failed, retrying frames-only:", e.message);
      }
    }
    return { text: await callOpenRouter(frames, null, buildPrompt(duration, niche, caption, false)), audio: false };
  }
  return { text: await callAnthropic(frames, buildPrompt(duration, niche, caption, false)), audio: false };
}

// ---------------- open-mode fallback limit (no auth configured) ----------------
const ipUsage = new Map();
function underIpLimit(ip) {
  const key = ip + "|" + new Date().toISOString().slice(0, 10);
  const count = ipUsage.get(key) || 0;
  if (count >= 5) return false;
  ipUsage.set(key, count + 1);
  return true;
}

// ---------------- routes ----------------
app.get("/api/config", (req, res) => {
  res.json({
    authOn: AUTH_ON,
    supabaseUrl: AUTH_ON ? SUPABASE_URL : null,
    supabaseAnonKey: AUTH_ON ? SUPABASE_ANON_KEY : null,
    paymentsOn: !!(stripe && STRIPE_PRICE_ID),
    freeLimit: FREE_MONTHLY_LIMIT,
  });
});

app.get("/api/me", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  const profile = await getProfile(user.id);
  const used = await sbCount(`grades?user_id=eq.${user.id}&created_at=gte.${monthStart()}&select=id`);
  res.json({ premium: !!profile?.is_premium, used, limit: FREE_MONTHLY_LIMIT });
});

app.get("/api/history", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  const rows = await sbGet(`grades?user_id=eq.${user.id}&select=created_at,hook_score,overall_score,result&order=created_at.desc&limit=30`);
  res.json(rows);
});

app.post("/api/checkout", async (req, res) => {
  try {
    if (!stripe || !STRIPE_PRICE_ID) return res.status(400).json({ error: "Payments aren't set up yet." });
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Sign in first." });
    const base = APP_URL || `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: user.id,
      customer_email: user.email,
      success_url: `${base}/?upgraded=1`,
      cancel_url: `${base}/`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/portal", async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: "Payments aren't set up yet." });
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Sign in first." });
    const profile = await getProfile(user.id);
    if (!profile?.stripe_customer_id) return res.status(400).json({ error: "No subscription found." });
    const base = APP_URL || `${req.protocol}://${req.get("host")}`;
    const session = await stripe.billingPortal.sessions.create({ customer: profile.stripe_customer_id, return_url: `${base}/` });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/grade", upload.single("video"), async (req, res) => {
  const tmpFiles = [];
  try {
    if (!OPENROUTER_KEY && !ANTHROPIC_KEY) return res.status(500).json({ error: "Server is missing an API key. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY." });
    if (!req.file) return res.status(400).json({ error: "No video uploaded." });

    // --- gate: auth mode vs open mode ---
    let user = null;
    if (AUTH_ON) {
      user = await getUser(req);
      if (!user) return res.status(401).json({ error: "Sign in with Google to grade videos." });
      await sbUpsertProfile(user.id, {});
      const profile = await getProfile(user.id);
      if (!profile?.is_premium) {
        const used = await sbCount(`grades?user_id=eq.${user.id}&created_at=gte.${monthStart()}&select=id`);
        if (used >= FREE_MONTHLY_LIMIT) {
          return res.status(402).json({ error: `You've used your ${FREE_MONTHLY_LIMIT} free grades this month.`, upgrade: true });
        }
      }
    } else {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
      if (!underIpLimit(ip)) return res.status(429).json({ error: "Daily free limit reached (5 grades). Come back tomorrow." });
    }

    const videoPath = req.file.path;
    tmpFiles.push(videoPath);
    const duration = await getDuration(videoPath);
    if (duration > 600) return res.status(400).json({ error: "Video is over 10 minutes — upload a short-form clip." });

    const times = targetTimes(duration);
    const frames = [];
    for (const t of times) {
      const framePath = path.join(os.tmpdir(), `${req.file.filename}-${t}.jpg`);
      tmpFiles.push(framePath);
      frames.push({ time: t, b64: await extractFrame(videoPath, t, framePath) });
    }

    const audioPath = path.join(os.tmpdir(), `${req.file.filename}.mp3`);
    tmpFiles.push(audioPath);
    const audioB64 = await extractAudio(videoPath, audioPath);

    const { text, audio } = await gradeWithModel(frames, audioB64, duration, req.body.niche || "", req.body.caption || "");
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    parsed.audioAnalyzed = audio;

    if (AUTH_ON && user) {
      await sbInsert("grades", { user_id: user.id, hook_score: parsed.hookScore, overall_score: parsed.overallScore, result: parsed });
    }
    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Analysis failed." });
  } finally {
    for (const f of tmpFiles) fs.unlink(f, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`HookCheck v2 on :${PORT}`);
  console.log(`  model: ${MODEL} via ${OPENROUTER_KEY ? "OpenRouter" : "Anthropic"}`);
  console.log(`  auth: ${AUTH_ON ? "Supabase (Google)" : "OPEN MODE — set SUPABASE_* vars to enable accounts"}`);
  console.log(`  payments: ${stripe && STRIPE_PRICE_ID ? "Stripe on" : "off — set STRIPE_* vars to enable"}`);
});
