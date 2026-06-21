# Spark Content QA Tool — Team Handoff

## What this is

An internal tool that automatically checks our annual reports, company profiles, microsites,
and digital deliverables for content and structural errors before they reach the client. It
compares a trusted source document against the final output and flags every difference, chapter
by chapter, so our Arabic reviewer and content team stop hunting through 60–80 page documents
by hand.

The tool exists because the problem we kept hitting was not a skill gap — our reviewers are
capable. It was a volume and attention problem: too many pages, too little time, and errors
slipping past manual review to the client. This tool front-loads the mechanical checks so the
human reviewer opens a pre-cleared file and focuses only on what needs judgment.

---

## The core logic (this is the important part)

The tool runs in one of two modes, chosen automatically from the language settings:

**Copy-accuracy mode (our most common case).** When the source and output are the SAME language
— English source vs English PDF, or Arabic source vs Arabic PDF — the content must match the
source word-for-word. Any difference is an error introduced during layout or production: a typo,
a transposed digit (2.47 becoming 2.74), a dropped paragraph, a changed date. The tool flags
every deviation from the source as a copy error.

**Translation mode.** When the source and output are DIFFERENT languages — English source vs
Arabic PDF — the content will not be identical because one side is translated. The tool checks
translation fidelity (meaning preserved), completeness (nothing missing), and that figures, dates,
and names are exact.

The four comparisons we do most:
1. English source → English PDF (copy-accuracy)
2. Arabic source → Arabic PDF (copy-accuracy)
3. English/Arabic source → website or microsite (copy-accuracy, live page fetch)
4. English source → Arabic PDF (translation)

Source files can be Word or PDF. Output can be PDF, website/microsite, or animated banner.

---

## What the tool produces

- **Three scores**: structure, content/copy match, and completeness, each out of 100, for an
  instant health read.
- **Chapter content view** (the default): each chapter expands to show its content compared
  element by element against the source — source on the left, output on the right, with
  mismatches highlighted and missing content flagged in place.
- **TOC map**: the source table of contents against the output, colour-coded match / mismatch / missing.
- **Sections view**: paragraph counts per chapter and sub-section status.
- **Sign-off workflow**: content team resolves each flagged item first, then the project manager
  gives final approval. PM approval is locked until every item is signed off. Every action is
  timestamped, creating an audit trail.
- **Export**: a full report with the audit trail for the project record.

---

## How we use it in the process

1. The content team finishes the file and runs it through the tool before it goes to review.
2. The tool produces the flagged report.
3. The content team resolves each flagged item and signs off, adding a resolution note.
4. The Arabic reviewer works from the cleared file, focusing on language quality rather than
   hunting for mechanical errors.
5. The project manager reviews the resolved report and gives final approval as a delivery gate.
6. The exported report goes into the project record as our QA audit trail.

---

## The two deliverables

**1. Prototype (spark-qa-prototype.html)**
A single file that opens in any browser with built-in sample data. Use this to experience the
full flow — running an analysis, opening chapters, switching comparison modes, testing sign-off.
IMPORTANT: the prototype uses sample data and always shows the same illustrative report. It is
for validating the experience, NOT for doing real QA work. Do not mistake the sample report for
a real result.

**2. Backend application (spark-qa-app folder)**
The real working tool. It runs real AI analysis on our actual files, fetches live websites,
reads Word documents, keeps our API key secure on the server, stores shared team reports, and is
password-protected. This needs to be deployed once (see SETUP-GUIDE.md in the folder). After
deployment everyone uses one URL with no installation.

---

## Deployment status and next steps

- The prototype is ready to circulate now for design validation.
- The backend is built and code-validated but NOT yet deployed. It needs roughly 20–30 minutes
  of setup on Render (or any Node host), ideally done by whoever owns our web infrastructure,
  because they should hold the hosting account, the API key, and the database from the start.
- We need an Anthropic API key from our TEAM account (not a personal one) for deployment.

Suggested sequence: circulate the prototype this week for feedback on the flow, then hand the
backend folder and setup guide to web infrastructure for deployment once the design is confirmed.

---

## Known limitations and honest notes

- The prototype's analysis is sample data only. Real analysis happens only in the deployed backend.
- The backend's free hosting tier (Render) sleeps after 15 minutes of inactivity and takes ~30
  seconds to wake. Fine for daily use; a paid tier (~$7/month) keeps it always on.
- On the free tier the report database can reset if the host restarts. For permanent storage, add
  a persistent disk or move to Postgres — a quick change for a developer.
- The tool handles text and structure. It cannot judge purely visual issues (e.g. an Arabic word
  breaking awkwardly across a line) — that still needs the reviewer's eye, but on a pre-cleared file.
