# HookCheck

Get graded before you post. Upload a short-form video, get a hook score, pacing notes, caption rewrites, hashtags, and flop warnings — powered by Claude.

## How it works
- Frontend uploads the raw video to the backend
- Backend extracts frames with ffmpeg (handles HEVC, H.264, anything)
- Frames go to the Claude API for grading
- Free tier: 5 grades per day per IP (v1 in-memory limit)

## Deploy on Railway
1. Push this repo to GitHub
2. New Railway project -> Deploy from GitHub repo (Dockerfile is auto-detected)
3. Add environment variable: `ANTHROPIC_API_KEY` (from console.anthropic.com)
4. Generate a domain in Railway settings

## Run locally
```
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```
Requires ffmpeg installed locally.

## Roadmap
- Supabase auth + real usage limits
- Stripe premium tier (unlimited grades)
- Audio/transcript analysis
- Capacitor wrap for the App Store
