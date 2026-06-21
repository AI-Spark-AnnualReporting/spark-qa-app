# Spark QA Tool — Setup Guide

This is a complete working application with a secure backend. It does everything we built:
bilingual PDF comparison, Word document reading, **live website and microsite fetching**,
section-to-page mapping, two-stage sign-off, and shared team reports.

You need to deploy it once. After that, your whole team uses one URL. No installation for them.

---

## What you need before starting

1. An OpenAI API key from your **team account** (platform.openai.com → API keys)
2. A free account on **Render.com** (the easiest host for this) — or your developer can use any Node host
3. About 20 minutes

---

## Option A — Deploy on Render (recommended, no developer needed)

### Step 1: Put the code on GitHub
1. Create a free account at github.com
2. Create a new repository (click the + icon, top right → New repository). Name it `spark-qa`. Keep it Private.
3. On the new repo page, click **uploading an existing file**
4. Drag in ALL the files from the `spark-qa-app` folder, keeping the structure:
   - `package.json`
   - `server.js`
   - the `public` folder with `index.html` inside it
5. Click **Commit changes**

### Step 2: Deploy on Render
1. Create a free account at render.com (sign in with GitHub — it links automatically)
2. Click **New +** → **Web Service**
3. Connect your `spark-qa` repository
4. Render auto-detects the settings. Confirm:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Before clicking Create, scroll to **Environment Variables** and add:
   - Key: `OPENAI_API_KEY`  → Value: your team API key
   - Key: `TEAM_PASSWORD`  → Value: a password your team will use to log in (e.g. `spark2026`)
6. Click **Create Web Service**

Render builds and deploys. After 2–3 minutes you get a URL like `https://spark-qa.onrender.com`.

### Step 3: Share with your team
Send them the URL and the team password. Done. They open the URL, enter the password once,
and use the tool. Everyone sees the same shared reports.

---

## Option B — Hand to your developer

The app is a standard Node.js + Express application. Everything they need:
- `npm install` then `npm start`
- Set two environment variables: `OPENAI_API_KEY` and `TEAM_PASSWORD` (optionally `OPENAI_MODEL`, defaults to `gpt-4o`)
- It serves on `process.env.PORT` (works on Render, Railway, Fly, Heroku, a VPS, or Docker)
- Reports are stored in SQLite (`reports.db`). For multiple server instances, point `DB_PATH`
  at a persistent volume, or swap SQLite for Postgres (one function to change in server.js).

---

## What works in this version that the single-file version could not

- **Same-language copy-accuracy as the default** — most of your work is English source vs English PDF,
  or Arabic source vs Arabic PDF. The tool now treats these as copy-accuracy checks: content must
  match the source word-for-word, and any difference (a typo, a transposed figure, a dropped paragraph)
  is flagged as a production error. Cross-language (English to Arabic) automatically switches to
  translation mode instead.
- **Chapter-by-chapter content comparison** — the report opens on a Chapter Content view where each
  chapter expands to show its content compared element by element against the source, source on the
  left and output on the right, with mismatches and missing content flagged in place.
- **Live website fetching** — the server actually reads your microsite pages, extracts headings,
  paragraphs, and RTL direction info, and compares them against the source document.
- **Sitemap crawling** — give it a sitemap URL and it reads every page automatically (up to 30).
- **Word documents** — the server extracts text from .docx files natively.
- **Secure API key** — the key lives on the server, never in the browser. Safe to share the URL.
- **Shared team reports** — everyone sees the same reports. A QA started by one person can be
  signed off by another. The audit trail is shared.
- **Password protection** — only people with the team password can use it.

---

## Notes

- The free Render tier sleeps after 15 minutes of inactivity and takes ~30 seconds to wake on the
  next visit. For a tool used daily this is fine. Upgrade to the paid tier (~$7/month) to keep it
  always on.
- The SQLite database on the free tier resets if Render restarts the service. For permanent report
  storage, add a Render persistent disk (a few clicks in the dashboard) and set `DB_PATH` to it,
  or move to Render's free Postgres. Your developer can do either in minutes.
- To change the team password later, update the `TEAM_PASSWORD` environment variable in the Render
  dashboard and the service restarts automatically.
