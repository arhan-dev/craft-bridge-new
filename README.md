# Craftbridge — AI-Driven Market Linkage & Smart Cataloging for Marginalised Artisans

**SIH26090** · Ministry of Social Justice and Empowerment (MoSJE) · Smart India Hackathon 2026

## Purpose
Craftbridge is a marketplace connecting marginalised artisans directly to buyers — removing middlemen, giving artisans fair, self-set pricing, and using AI to remove the design/copywriting skill barrier to listing a product for sale.

This is a real, working full-stack build:
- A public marketplace (browse, filter, contact-to-buy on WhatsApp)
- Real artisan accounts (Supabase Auth — sign up, log in, session persistence)
- A functional Artisan Dashboard (overview, manage your own products, edit profile)
- A real AI cataloging feature: upload a photo → Gemini generates the listing → you review, edit, and publish
- Everything an artisan publishes is stored in Supabase and immediately live on the public marketplace

## Main Features
- **Hero, category browser, product catalog** — public marketplace, always populated even if the backend isn't configured yet (see "How data flows" below)
- **Artisan accounts** — Supabase Auth sign up / log in / log out, with a profile (business name, region, craft category, WhatsApp number)
- **Artisan Dashboard** — Overview stats, My Products (edit/delete your own listings), Profile editor
- **Smart Cataloging (AI feature)** — upload a product photo → Gemini analyzes it and generates a title, category, description, and tags; you review and edit before publishing
- **Publishing** — the AI Product Listing form uploads the photo to Supabase Storage and inserts/updates a row in the `products` table, owned by the logged-in artisan
- **Contact Artisan to Buy** — every product opens a pre-filled WhatsApp chat, using the artisan's own WhatsApp number when the product came from a real artisan account, or a shared demo number for the built-in sample products
- Fully responsive: mobile (with working hamburger nav + category filtering), tablet, and laptop/projector layouts

## Technology Stack
- Plain HTML, CSS, and vanilla JavaScript — **no framework, no build step**
- [Supabase](https://supabase.com) for Auth, Postgres database, and Storage
- Two [Vercel Serverless Functions](https://vercel.com/docs/functions):
  - `api/caption.js` — the only place the Gemini key is used
  - `api/config.js` — hands the browser the public Supabase URL + anon key at runtime (no build step needed to inject env vars into a static HTML file)
- Deployed on **Vercel**, connected directly to this GitHub repository

## File Structure
```
/
├── index.html                       ← entire site: markup, styles, and JS
├── images/
│   └── products/                    ← photos for the built-in fallback/demo products
├── api/
│   ├── caption.js                   ← Vercel Serverless Function — the ONLY place the Gemini key is used
│   └── config.js                    ← Vercel Serverless Function — serves public Supabase config to the browser
├── supabase/
│   └── schema.sql                   ← run this once in your Supabase project's SQL Editor
├── package.json                     ← declares ESM ("type": "module") so the API files can use `export default`
├── vercel.json                      ← static site + serverless function config
├── .env.example                     ← template for local env vars (no real secrets)
├── .gitignore
└── README.md
```

## How data flows
- **Public catalog**: on load, the page immediately renders a set of built-in **fallback/demo products** (hardcoded in `index.html`, images in `images/products/`) so the marketplace is never blank — not on first load, and not if Supabase is misconfigured or unreachable. It then fetches real, published products from Supabase (`products` table, `status = 'published'`) and merges them in on top. Any fetch error is caught and logged to the console; the page keeps working either way.
- **Auth**: handled entirely by Supabase Auth in the browser, using the public anon key (see "Environment Variables" below). Sessions persist across reloads.
- **AI Cataloging**: browser → `POST /api/caption` (image + mimeType) → Gemini → structured JSON → auto-fills the listing form. The Gemini key never leaves the server.
- **Publishing**: on submit, the browser uploads the photo directly to the `product-images` Supabase Storage bucket (using the artisan's own authenticated session), then inserts or updates a row in `products` with `artisan_id` set to that artisan. Row Level Security ensures artisans can only edit/delete their own rows.

## Running Locally
1. Install the [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
2. Set up a Supabase project (see below) and copy `.env.example` to `.env`, filling in all three values.
3. From the project root, run:
   ```
   vercel dev
   ```
   This serves `index.html` as a static file and runs `api/caption.js` / `api/config.js` locally at `http://localhost:3000/api/...`.

Opening `index.html` directly in a browser (without `vercel dev`) will still show the public catalog (fallback data), but AI cataloging, login, and publishing won't work since there's no server to host the API routes.

## Setting Up Supabase
1. Create a free project at [supabase.com](https://supabase.com).
2. Go to your project's **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it. This creates the `profiles` and `products` tables, all Row Level Security policies, and the public `product-images` Storage bucket.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **anon / public key** → this is your `SUPABASE_ANON_KEY` (this key is meant to be public — real security comes from the RLS policies in `schema.sql`, not from keeping this key secret)
4. (Optional) In **Authentication → Providers**, you can disable "Confirm email" while testing locally so new artisan sign-ups can log in immediately.

## Deploying to Vercel
1. Push this repo to GitHub.
2. In the [Vercel dashboard](https://vercel.com/new), click **Add New → Project**, and import the GitHub repository.
3. Framework preset: choose **Other** (static site, no build step — Vercel will still auto-detect and deploy `api/caption.js` and `api/config.js` as serverless functions).
4. Go to the project → **Settings → Environment Variables**, and add all three:
   - `GEMINI_API_KEY` — your real Gemini API key
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_ANON_KEY` — your Supabase anon/public key
   - Apply each to **Production**, **Preview**, and **Development**.
5. Deploy (or trigger a redeploy if you added the env vars after the first deploy — they only apply to deployments created after they're set).
6. Test on the live URL: sign up as an artisan, publish a product with a photo via AI Cataloging, and confirm it appears on the public marketplace and in "My Products."

**Never commit real secrets** (`GEMINI_API_KEY`, or your Supabase keys) to `index.html`, any `api/*.js` file, `.env`, this README, or anywhere else in the repository. They belong only in Vercel's Environment Variables and in your local, git-ignored `.env` file. Note that `SUPABASE_ANON_KEY` is a public-by-design key (unlike `GEMINI_API_KEY`), but it's still kept out of source and injected via `api/config.js` so the project has no build step and stays easy to reconfigure per environment.

## How the AI Product Catalogue Listing Works
1. A logged-in artisan uploads or drags in a product photo on the **AI Product Listing** section (login-gated).
2. The browser reads the image as base64 and sends `{ image, mimeType }` to `POST /api/caption`.
3. `api/caption.js` reads `GEMINI_API_KEY` from the environment and sends the image + a structured prompt to the Gemini API.
4. Gemini returns a JSON object with `title`, `category`, `description`, and `tags`.
5. `api/caption.js` safely strips any markdown code fences and parses the JSON before returning it.
6. The frontend auto-fills the listing review form — the artisan can review and edit everything before publishing.
7. On submit, the photo is uploaded to Supabase Storage and the listing is inserted (or updated, if editing an existing product) into the `products` table, owned by that artisan.
8. If the Gemini request fails for any reason, a clear error message is shown and the artisan can still fill in the form manually and publish.

## The Artisan Dashboard
Login-gated. Once logged in, an artisan sees:
- **Overview** — total listings, how many are live, craft category
- **My Products** — every product they've published, with Edit (reopens the listing form, pre-filled) and Delete
- **Profile** — business name, region, craft category, and WhatsApp number (used for the "Contact Artisan to Buy" button on their products)

## Contact Artisan to Buy (WhatsApp)
Every product card and product modal includes a "Contact Artisan to Buy" button. Clicking it opens WhatsApp (`https://wa.me/...`) in a new tab with a message pre-filled with that product's exact name and price, using `encodeURIComponent` so special characters and spacing come through correctly.
- For products published by a real artisan account, it uses that artisan's own WhatsApp number from their profile.
- For the built-in fallback/demo products, it uses one shared test number (`+91 88407 09519`).

## Notes for Judges / Reviewers
- The fallback/demo product data lives in `STATIC_PRODUCTS` in `index.html`, structured to match the Supabase `products` table columns 1:1.
- Product photos for the fallback data live under `images/products/` and are referenced by relative path rather than embedded as base64, keeping `index.html` lean and fast to load.
- If `SUPABASE_URL` / `SUPABASE_ANON_KEY` aren't set on a given deployment, the public catalog still works (fallback data only), and login/dashboard/publishing show a clear message instead of failing silently.
