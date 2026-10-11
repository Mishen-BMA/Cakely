# Cakely

Cakely is a Sri Lankan homemade cake store: a React/Vite storefront backed by
a Node.js API (running as a single Netlify Function) and a Supabase Postgres
database, all deployable on free tiers.

## Stack

- **Frontend:** React + Vite, served as a static site by Netlify
- **Backend:** Express app running inside one Netlify Function (`netlify/functions/api.js`)
- **Database:** Supabase Postgres for products, product images, orders, and customer accounts
- **Hosting:** Netlify (frontend and backend both, on the same domain)

This replaces the earlier Flask/SQLAlchemy backend — Netlify Functions don't
support Python natively (JS, TS, and Go only), so the backend logic was
ported to Node while keeping the exact same `/api/...` routes and behavior.

## One-time Supabase setup

1. **Run the schema.** In your Supabase project dashboard: **SQL Editor →
   New query**, paste the contents of `supabase/schema.sql`, and run it.
   This creates all the tables and locks them down with Row Level Security
   (only your backend's secret key can read/write — nothing is publicly
   accessible).
2. **Get your keys.** Project Settings → Data API for the project URL,
   Project Settings → API Keys for the secret key (`sb_secret_...`).

## One-time seed (admin user + starter products + coupons)

```bash
cp .env.example .env
# fill in .env with your real SUPABASE_URL and SUPABASE_SECRET_KEY
npm install
npm run seed
```

This creates the admin login (`ADMIN_USERNAME` / `ADMIN_PASSWORD`; set both
before seeding), eight starter products with placeholder images (swap
them for real photos from the admin panel after deploying), and the sample
coupon codes (`CAKE10`, `CAKE20`, `SAVE500`, etc.).

## Deploy to Netlify

1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
   Netlify will read `netlify.toml` automatically (build command, publish
   directory, and function directory are already configured — you don't
   need to change the defaults it suggests).
3. Before the first deploy, go to **Site configuration → Environment
   variables** and add:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
   - `JWT_SECRET_KEY` — any long random string
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD`
   - `EVENT_HASH_SALT` — a long random value used to hash contact details in events
   - `ADMIN_RESET_PASSWORD=false` unless you intend to reset an existing admin password
   - `RULELOCK_API_URL` — base URL only, such as `https://rulelock.example` (Cakely appends `/review-order`)
   - `RULELOCK_API_TOKEN` when RuleLock is enabled
   - `CAKELY_SECURITY_MODE` = `normal`
   - Leave `FRONTEND_URL` and `VITE_API_URL` blank — frontend and backend
     share the same Netlify domain, so no CORS setup is needed.
4. Deploy. Your site and its API both live at the same Netlify URL —
   `https://your-site.netlify.app` for the storefront,
   `https://your-site.netlify.app/api/...` for the API (Netlify rewrites
   that to the function automatically).

## Run locally

```bash
# frontend
cd frontend
npm install
npm run dev
```

For local API testing, install the Netlify CLI (`npm i -g netlify-cli`) and
run `netlify dev` from the repo root — it serves the frontend and emulates
the function together, reading env vars from your `.env`.

## Deploy to Render

This repository also includes a Render Blueprint in `render.yaml`. In Render,
choose **New → Blueprint**, connect this GitHub repository, and create the
`cakely` web service. Render builds the React frontend, serves it from the
Node server, and exposes the API on the same domain.

Before deploying, enter the values marked as secret in the Render setup:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `JWT_SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

`CAKELY_SECURITY_MODE=normal` is included in the Blueprint. Configure
`EVENT_HASH_SALT` and RuleLock credentials if required. Do not set
`VITE_API_URL`; the frontend uses the same Render domain at `/api`.

## Deploy the frontend to GitHub Pages (Render API + Supabase)

The GitHub Pages workflow in `.github/workflows/deploy-pages.yml` publishes
only `frontend/dist`. It builds the frontend with a public URL for the Render
API; Supabase remains private to the backend because its secret key is never
included in the frontend build.

1. In GitHub, open **Settings â†’ Pages**, choose **GitHub Actions** as the
   source, then push to `main` (or run the workflow manually).
2. In **Settings â†’ Secrets and variables â†’ Actions â†’ Variables**, create
   `VITE_API_URL` with your Render service URL, for example
   `https://your-service.onrender.com`. This is intentionally a repository
   variable rather than a secret: browser clients need to know the API URL.
3. In Render, set `FRONTEND_URL` to
   `https://charukagimhan2020-hub.github.io`. The `/cakely-final` path is not
   included because CORS checks the origin only. Redeploy the Render service
   after changing it. The Blueprint now declares this value for new/synced
   services as well.

The site will be available at
`https://charukagimhan2020-hub.github.io/cakely-final/`. Pages uses hash
routes (`#/cakes`, `#/admin`, etc.) so direct navigation and refreshes do not
need server-side rewrite rules.

## Notes / limitations to know about

- **Product images are database-backed.** Admin product uploads are stored in
  `products.image`; product list APIs return cached image URLs instead of the
  base64 image data.
- **Rate limiting is per-instance, not global.** The login/register rate
  limiter (`netlify/functions/api.js`) is in-memory per warm function
  container, so it resets on cold starts and isn't shared across concurrent
  instances. Good enough for a coursework-scale demo; not a substitute for
  a real distributed rate limiter in production.
- **Admin bootstrap** creates the configured administrator only when that
  account is missing. Existing passwords remain unchanged unless
  `ADMIN_RESET_PASSWORD=true` is explicitly configured. Production startup
  requires both `JWT_SECRET_KEY` and `ADMIN_PASSWORD`.
- **Security mode:** keep `CAKELY_SECURITY_MODE=normal` in production.
  `research` mode intentionally disables coupon-stacking protection and
  exists only for demonstrating the vulnerability in a controlled way.

## Tests and CI

### RuleLock attack demo

Set `CAKELY_URL`, `DEMO_USER`, and `DEMO_PASSWORD` for a running demo shop.
Run `node scripts/attack-demo.mjs` to log in and post attack checkouts directly to the API.
It tries stacked percentage coupons and a quantity of 50, then creates and cancels three COD orders.
It submits a fourth COD order and prints the C2, C3, and C4 summary for each review.
Use a demo customer account with at least two active percentage coupons.

Install root and frontend dependencies, then run the tests:

```bash
npm ci
npm ci --prefix frontend
npm test
```

The GitHub Actions workflow
`.github/workflows/backend-tests.yml` runs the backend contract and API tests
for pushes and pull requests.
