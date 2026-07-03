# HookCheck v2

Get graded before you post. Upload a short-form video, get a harsh hook score, audio hook analysis, pacing notes, caption rewrites, flop warnings, and a shareable grade card.

## Architecture
- Express backend, static frontend (no build step)
- ffmpeg extracts 7 frames + first 12s of audio server-side (all codecs work, incl. HEVC)
- Grading via OpenRouter (default: google/gemini-2.5-flash, override with MODEL) or Anthropic direct
- Supabase: Google sign-in, grade history, monthly usage limits (3 free/month)
- Stripe: premium subscription (unlimited grades), webhook auto-activates premium
- Graceful degradation: without Supabase vars it runs in open mode (5 grades/day per IP); without Stripe vars the upgrade UI hides

## Environment variables (Railway -> Variables)
| Variable | Required | What |
|---|---|---|
| OPENROUTER_API_KEY | yes* | openrouter.ai key (*or ANTHROPIC_API_KEY) |
| MODEL | no | override model, e.g. anthropic/claude-sonnet-4.5 |
| SUPABASE_URL | for accounts | Supabase project URL |
| SUPABASE_ANON_KEY | for accounts | Supabase anon/public key |
| SUPABASE_SERVICE_ROLE_KEY | for accounts | Supabase service_role key (secret) |
| STRIPE_SECRET_KEY | for payments | sk_live_... or sk_test_... |
| STRIPE_PRICE_ID | for payments | price_... of the subscription |
| STRIPE_WEBHOOK_SECRET | for payments | whsec_... from the webhook endpoint |
| APP_URL | recommended | e.g. https://yourapp.up.railway.app |

## Supabase setup
1. supabase.com -> New project
2. SQL Editor -> run:
```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_premium boolean default false,
  stripe_customer_id text
);
create table grades (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  hook_score int,
  overall_score int,
  result jsonb
);
alter table profiles enable row level security;
alter table grades enable row level security;
```
3. Authentication -> Providers -> Google -> enable (needs a Google Cloud OAuth client ID/secret; Google's console walks you through it — add your Supabase callback URL)
4. Authentication -> URL Configuration -> set Site URL to your Railway domain
5. Project Settings -> API -> copy URL, anon key, service_role key into Railway

## Stripe setup (18+ account holder)
1. Create a Product: "HookCheck Premium", recurring $3.99/month -> copy the price_... ID
2. Developers -> Webhooks -> Add endpoint: `https://YOUR-DOMAIN/api/stripe-webhook`
   Events: `checkout.session.completed`, `customer.subscription.deleted` -> copy whsec_...
3. Put STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET into Railway
4. Test with card 4242 4242 4242 4242 while in test mode

## Run locally
```
npm install
OPENROUTER_API_KEY=... npm start
```
Requires ffmpeg installed.
