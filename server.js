import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import * as cheerio from 'cheerio';
import mammoth from 'mammoth';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ---- API key from environment (NEVER hardcode) ----
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('FATAL: OPENAI_API_KEY environment variable is not set.');
  console.error('Set it in your hosting platform dashboard before starting.');
}
// Pass a placeholder when unset so the server still boots and serves the UI;
// the per-endpoint `if (!API_KEY)` guards block real calls until a key is set.
const openai = new OpenAI({ apiKey: API_KEY || 'not-configured' });

// ---- Model (override with OPENAI_MODEL env var) ----
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

// ---- Optional team password gate ----
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || '';

// ---- Storage for shared reports ----
// Production (Vercel/any serverless): set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) for a
// real shared, persistent SQLite-compatible DB. Without it, falls back to in-memory
// storage — fine for local dev, but NOT persistent or shared across serverless instances.
async function createStore() {
  if (process.env.TURSO_DATABASE_URL) {
    const { createClient } = await import('@libsql/client/web');
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });
    await client.execute(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    return {
      async all() {
        const r = await client.execute('SELECT id, name, data, updated_at FROM reports ORDER BY updated_at DESC');
        return r.rows;
      },
      async get(id) {
        const r = await client.execute({ sql: 'SELECT data FROM reports WHERE id = ?', args: [id] });
        return r.rows[0] || null;
      },
      async upsert(id, name, data, updated_at) {
        await client.execute({
          sql: `INSERT INTO reports (id, name, data, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data, updated_at=excluded.updated_at`,
          args: [id, name, data, updated_at]
        });
      },
      async del(id) {
        await client.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [id] });
      }
    };
  }
  console.warn('No TURSO_DATABASE_URL set — using in-memory report storage (not persistent, not shared across instances).');
  const mem = new Map();
  return {
    async all() { return [...mem.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)); },
    async get(id) { return mem.get(id) || null; },
    async upsert(id, name, data, updated_at) { mem.set(id, { id, name, data, updated_at }); },
    async del(id) { mem.delete(id); }
  };
}
const store = await createStore();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// ---- Simple auth middleware ----
function checkAuth(req, res, next) {
  if (!TEAM_PASSWORD) return next();
  const pw = req.headers['x-team-password'] || '';
  if (pw !== TEAM_PASSWORD) return res.status(401).json({ error: 'Invalid team password' });
  next();
}

// ---- Check if a team password is required (for the frontend) ----
app.get('/api/config', (req, res) => {
  res.json({ requiresPassword: !!TEAM_PASSWORD, hasApiKey: !!API_KEY });
});

// ---- Verify password ----
app.post('/api/auth', (req, res) => {
  if (!TEAM_PASSWORD) return res.json({ ok: true });
  res.json({ ok: req.body.password === TEAM_PASSWORD });
});

// ---- Fetch and extract text + structure from a live URL ----
async function fetchPageContent(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SparkQA/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return { url, error: `HTTP ${resp.status}`, text: '', headings: [] };
    const html = await resp.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, svg').remove();

    const headings = [];
    $('h1, h2, h3, h4').each((_, el) => {
      const level = parseInt(el.tagName.substring(1));
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text) headings.push({ level, text });
    });

    const paragraphs = [];
    $('p, li').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length > 10) paragraphs.push(text);
    });

    // detect RTL
    const htmlDir = $('html').attr('dir') || '';
    const bodyDir = $('body').attr('dir') || '';
    const rtlElements = $('[dir="rtl"]').length;

    return {
      url,
      headings,
      paragraphCount: paragraphs.length,
      text: paragraphs.join('\n'),
      rtlInfo: { htmlDir, bodyDir, rtlElements },
      title: $('title').text().trim()
    };
  } catch (e) {
    return { url, error: e.message, text: '', headings: [] };
  }
}

// ---- Extract URLs from a sitemap ----
async function fetchSitemapUrls(sitemapUrl) {
  try {
    const resp = await fetch(sitemapUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls = [];
    $('loc').each((_, el) => {
      const u = $(el).text().trim();
      if (u) urls.push(u);
    });
    return urls.slice(0, 30); // cap to avoid runaway crawls
  } catch (e) {
    return [];
  }
}

// ---- Main QA endpoint ----
app.post('/api/qa', checkAuth, upload.fields([{ name: 'srcFile' }, { name: 'outFile' }]), async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'Server API key not configured. Set OPENAI_API_KEY in the hosting dashboard.' });

    const body = JSON.parse(req.body.payload || '{}');
    const { srcLang, outLang, srcFmt, outFmt, checks, ctx, mapping, webMode, outUrl, outSitemap, outUrlList, outAnim, outAnimUrl, srcPaste, outPaste } = body;

    const ll = { en: 'English', ar: 'Arabic' };
    const fl = { pdf: 'PDF', word: 'Word document', paste: 'pasted text', website: 'website / microsite', animated: 'animated banner' };
    const srcDesc = `${ll[srcLang]} ${fl[srcFmt]}`;
    const outDesc = `${ll[outLang]} ${fl[outFmt]}`;
    const isCross = srcLang !== outLang;
    const isDTW = (srcFmt === 'pdf' || srcFmt === 'word') && outFmt === 'website';

    // Build the user content blocks
    const userBlocks = [];
    let srcText = '', outText = '';

    // --- Source ---
    const srcFile = req.files?.srcFile?.[0];
    if (srcFmt === 'pdf' && srcFile) {
      userBlocks.push({ type: 'file', file: { filename: 'source.pdf', file_data: `data:application/pdf;base64,${srcFile.buffer.toString('base64')}` } });
    } else if (srcFmt === 'word' && srcFile) {
      const result = await mammoth.extractRawText({ buffer: srcFile.buffer });
      srcText = result.value;
    } else if (srcFmt === 'paste') {
      srcText = srcPaste || '';
    }

    // --- Output ---
    const outFile = req.files?.outFile?.[0];
    let webData = null;
    if (outFmt === 'pdf' && outFile) {
      userBlocks.push({ type: 'file', file: { filename: 'output.pdf', file_data: `data:application/pdf;base64,${outFile.buffer.toString('base64')}` } });
    } else if (outFmt === 'website') {
      // ACTUALLY fetch the live pages
      let urls = [];
      if (webMode === 'single' && outUrl) urls = [outUrl];
      else if (webMode === 'sitemap' && outSitemap) urls = await fetchSitemapUrls(outSitemap);
      else if (webMode === 'list' && outUrlList) urls = outUrlList.split('\n').map(u => u.trim()).filter(Boolean);
      // Also include mapped URLs
      if (mapping && mapping.length) {
        mapping.forEach(m => { if (m.url && !urls.includes(m.url)) urls.push(m.url); });
      }
      urls = [...new Set(urls)].slice(0, 30);
      const pages = await Promise.all(urls.map(fetchPageContent));
      webData = pages;
      outText = pages.map(p => {
        if (p.error) return `[PAGE: ${p.url}] ERROR fetching: ${p.error}`;
        return `[PAGE: ${p.url}]\nTitle: ${p.title}\nRTL info: html dir="${p.rtlInfo.htmlDir}", body dir="${p.rtlInfo.bodyDir}", ${p.rtlInfo.rtlElements} RTL elements\nHeadings:\n${p.headings.map(h => '  '.repeat(h.level - 1) + 'H' + h.level + ': ' + h.text).join('\n')}\nParagraph count: ${p.paragraphCount}\nContent:\n${p.text.slice(0, 4000)}`;
      }).join('\n\n---\n\n');
    } else if (outFmt === 'animated') {
      outText = outAnim || '';
      if (outAnimUrl) {
        const p = await fetchPageContent(outAnimUrl);
        if (!p.error) outText += `\n\nBanner page content:\n${p.text.slice(0, 2000)}`;
      }
    } else if (outFmt === 'paste') {
      outText = outPaste || '';
    }

    // Build mode description. Same-language = copy-accuracy (most common case). Cross-language = translation.
    const compareMode = isCross ? 'translation' : 'copy';
    let modeDesc, mapInstr = '';
    if (isCross) {
      modeDesc = `TRANSLATION MODE. Cross-language comparison: ${srcDesc} is the source of truth. ${outDesc} is the translated output. The content will NOT be word-for-word identical because one side is translated. Check translation fidelity (meaning preserved), completeness (nothing missing), and that figures, dates, and proper names are exact. Label content differences as translation issues.`;
    } else if (isDTW) {
      modeDesc = `COPY-ACCURACY MODE. Same-language document-to-microsite check: ${srcDesc} is the approved source. The microsite is the digital build. Content must match the source WORD-FOR-WORD. Any deviation is an error introduced during the build — a dropped paragraph, a mistyped figure, a changed heading, reordered content. Flag every difference from the source.`;
    } else {
      modeDesc = `COPY-ACCURACY MODE. Same-language comparison: ${srcDesc} is the source of truth, ${outDesc} is the output. They are the same language, so content must match the source WORD-FOR-WORD. Any difference is an error introduced during layout or production — a typo, a transposed digit, a dropped paragraph, a changed date. This is the MOST COMMON case. Flag every deviation from the source as a copy error, not a translation issue.`;
    }

    if (isDTW) {
      mapInstr = mapping && mapping.length
        ? '\n\nSECTION-TO-PAGE MAPPING:\n' + mapping.map(r => `"${r.section}" -> ${r.url || 'same page as previous'}`).join('\n')
        : '\n\nNo explicit mapping provided. Infer the mapping from document structure and the fetched page content below.';
    }

    const checksText = (checks || []).join('; ');

    const sys = `You are a senior bilingual Arabic-English QA specialist for GCC institutional documents, annual reports, company profiles, and corporate digital content.

${modeDesc}${mapInstr}
${outLang === 'ar' ? 'The output is Arabic. The fetched page data includes RTL direction info — use it to flag any pages or elements that are not correctly set to RTL.' : ''}
${isDTW ? `For document-to-microsite comparison:
1. Map each document section to its microsite page (use provided mapping or infer from the fetched content).
2. For each section, verify all headings, paragraphs, data points, callouts, and captions from the document appear on the correct page.
3. Flag content in the document but missing from the microsite.
4. Flag content on the wrong microsite page.
5. Use the RTL info in the fetched data to flag direction problems.` : ''}

Return ONLY valid JSON, no preamble, no markdown fences:
{"summary":{"total_issues":number,"critical":number,"warning":number,"info":number,"passed":number,"structure_score":number,"content_score":number,"completeness_score":number},"mode":"${compareMode}","toc_comparison":[{"level":1,"source_entry":"text","output_entry":"text","status":"match|mismatch|missing_output|missing_source|order_wrong","note":"brief","page_url":"URL if applicable"}],"chapter_content":[{"chapter_id":"Ch 3","chapter_title":"text","status":"ok|diff|warn","matched_count":number,"issue_count":number,"rows":[{"type":"ok|diff|miss|warn","name":"element name e.g. Net profit figure","source_text":"the source text","output_text":"the output text, empty string if missing","note":"explanation if not ok"}]}],"section_analysis":[{"section_id":"S01","source_heading":"text","output_heading":"text","heading_status":"match|mismatch|missing","paragraph_count_source":0,"paragraph_count_output":0,"paragraph_status":"match|count_mismatch|order_issue","page_url":"URL if applicable","subsections":[{"source_heading":"text","output_heading":"text","status":"match|mismatch|missing"}]}],"issues":[{"id":"QA001","severity":"critical|warning|info|pass","category":"TOC Structure|Section Heading|Sub-section|Paragraph Order|Missing Content|Wrong Page|Translation|Copy Accuracy|RTL/Alignment|Placeholder|Numbers/Dates|Diacritics|Passed","section_ref":"section","page_ref":"URL if applicable","title":"short title","source_excerpt":"text","output_excerpt":"text","explanation":"clear explanation","recommendation":"specific fix"}]}

IMPORTANT for chapter_content: for each chapter, list its key content elements (headings, paragraphs, figures, sub-sections) as rows. type "ok" = matches source exactly; "diff" = content differs (in copy mode this is a copy error, in translation mode a translation issue); "miss" = present in source but absent in output; "warn" = present but needs review (e.g. reordered, RTL rendering). Include matching rows too, not just problems, so the reviewer sees the full chapter.

severity: critical=missing section/major mismatch/placeholder/transposed financial figure; warning=minor; info=style note; pass=confirmed clean (include 2-4).${ctx ? '\nContext: ' + ctx : ''}`;

    // Assemble the text block
    let textIntro = `Full structural QA. Comparison: ${srcDesc} (source) vs ${outDesc} (output). Checks: ${checksText}.`;
    if (srcText) textIntro += `\n\nSOURCE CONTENT (${srcDesc}):\n${srcText.slice(0, 12000)}`;
    if (outText) textIntro += `\n\nOUTPUT CONTENT (${outDesc}):\n${outText.slice(0, 16000)}`;
    if (srcFmt === 'pdf' && srcFile) textIntro += `\n\nThe source ${srcDesc} is attached as a document.`;
    if (outFmt === 'pdf' && outFile) textIntro += `\n\nThe output ${outDesc} is attached as a document.`;

    userBlocks.unshift({ type: 'text', text: textIntro });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userBlocks }
      ]
    });

    let raw = (completion.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    let result;
    try { result = JSON.parse(raw); }
    catch (e) { return res.status(500).json({ error: 'Could not parse AI response', raw: raw.slice(0, 500) }); }

    result._meta = { srcDesc, outDesc, isAR: outLang === 'ar', isDTW, compareMode, fetchedPages: webData ? webData.map(p => ({ url: p.url, error: p.error || null, headingCount: p.headings?.length || 0 })) : null };
    res.json(result);

  } catch (err) {
    console.error('QA error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Panel review endpoint ----
app.post('/api/review', checkAuth, async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'Server API key not configured.' });
    const { role, focus, context } = req.body;
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 500,
      messages: [
        { role: 'system', content: `You are a ${role}. Give honest, specific, actionable feedback in plain prose — no bullets, no headers. 3-4 sentences.` },
        { role: 'user', content: `Context: ${context}\nFocus: ${focus}` }
      ]
    });
    const text = completion.choices?.[0]?.message?.content || '';
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Shared report storage (visible to whole team) ----
app.get('/api/reports', checkAuth, async (req, res) => {
  const rows = await store.all();
  res.json(rows.map(r => ({ id: r.id, name: r.name, updated_at: r.updated_at, ...JSON.parse(r.data) })));
});

app.get('/api/reports/:id', checkAuth, async (req, res) => {
  const row = await store.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(row.data));
});

app.put('/api/reports/:id', checkAuth, async (req, res) => {
  const { name, data } = req.body;
  await store.upsert(req.params.id, name, JSON.stringify(data), new Date().toISOString());
  res.json({ ok: true });
});

app.delete('/api/reports/:id', checkAuth, async (req, res) => {
  await store.del(req.params.id);
  res.json({ ok: true });
});

// On Vercel (and other serverless platforms) the app is exported as a handler instead of
// binding a port. Locally, start a normal HTTP server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Spark QA app running on port ${PORT}`);
    console.log(`API key configured: ${!!API_KEY}`);
    console.log(`Team password protection: ${!!TEAM_PASSWORD}`);
  });
}

// Export the Express app so Vercel (api/index.js) can use it as a serverless handler.
export default app;
