// Cleo's Makeover: minimal YouCam proxy (keeps your API key off the browser)
// Setup:  npm init -y && npm i express
// Run:    YOUCAM_API_KEY=your_key node server.js     (Node 18+)
// Windows PowerShell:  $env:YOUCAM_API_KEY="your_key"; node server.js
// Put your front end in a folder called "public" next to this file.

const express = require('express');
const path = require('path');

// Load .env (one KEY=value per line) from the folder next to this file. No extra packages.
// Values in .env override anything already set in the terminal, so an old key left in
// a PowerShell window can't shadow the new one.
try {
  const raw = require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').replace(/^\uFEFF/, '');
  raw.split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
  console.log('Loaded settings from .env');
} catch (e) {
  console.log('No .env file found next to server.js (looking in ' + __dirname + ')');
}

// Strip stray spaces, quotes and an accidental "Bearer " prefix from the pasted key
const KEY = (process.env.YOUCAM_API_KEY || '')
  .trim()
  .replace(/^["']|["']$/g, '')
  .replace(/^Bearer\s+/i, '')
  .trim();
if (!KEY) {
  console.error('Set YOUCAM_API_KEY first.');
  process.exit(1);
}
// Safe check: length and last 4 characters only, never the whole key
console.log(`Key loaded: ${KEY.length} characters, ends with "${KEY.slice(-4)}"`);

const BASE = process.env.YOUCAM_BASE || 'https://yce-api-01.makeupar.com';
const MAX_SCANS = Number(process.env.MAX_SCANS || 40); // protects your unit budget
let scans = 0;

// SD concerns. Do not mix with HD names in one request.
const SD = [
  'wrinkle', 'droopy_upper_eyelid', 'droopy_lower_eyelid', 'firmness', 'acne',
  'moisture', 'eye_bag', 'dark_circle_v2', 'age_spot', 'radiance', 'redness',
  'oiliness', 'pore', 'texture', 'tear_trough', 'skin_type',
];

const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(label, url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.status && body.status !== 200)) {
    // Shown in your terminal so you can see exactly which step failed and why
    console.error(`[${label}] HTTP ${res.status}`, JSON.stringify(body).slice(0, 400));
    const err = new Error(`${label}: ${body.error || 'HTTP ' + res.status}`);
    err.code = body.error_code;
    throw err;
  }
  return body;
}

// Turn the raw output list into something the UI can use directly.
// The UI should rank and compare with raw_score. ui_score is a flattering display number.
function shape(output) {
  const out = { concerns: {}, skinType: {}, overall: null, skinAge: null, resizedImage: null };
  for (const o of output) {
    if (o.type === 'skin_type') out.skinType[o.region] = o.skin_type;
    else if (o.type === 'all') out.overall = o.score;
    else if (o.type === 'skin_age') out.skinAge = o.score;
    else if (o.type === 'resize_image') out.resizedImage = (o.mask_urls || [])[0] || null;
    else out.concerns[o.type] = { raw: o.raw_score, ui: o.ui_score, mask: (o.mask_urls || [])[0] || null };
  }
  return out;
}

const PORT = Number(process.env.PORT) || 3000; // hosting platforms provide PORT
const PER_IP_SCANS = Number(process.env.PER_IP_SCANS || 6);   // scans per visitor per 24 hours
const PER_IP_VTO = Number(process.env.PER_IP_VTO || 12);      // look try-ons per visitor per 24 hours
const ipHits = {};
function ipLimited(req, kind, max) {
  const now = Date.now(), k = kind + ':' + req.ip;
  const recent = (ipHits[k] = (ipHits[k] || []).filter((t) => now - t < 24 * 36e5));
  if (recent.length >= max) return true;
  recent.push(now);
  return false;
}
const LIMIT_MSG = 'The demo limit for this connection has been reached. Please watch the video, or run the project locally with your own YouCam key.';

const app = express();
app.set('trust proxy', 1); // so req.ip is the visitor behind a hosting proxy
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Make a missing page obvious instead of showing "Cannot GET /"
const fs = require('fs');
const PAGE = path.join(__dirname, 'public', 'index.html');
console.log(fs.existsSync(PAGE) ? 'Page found: ' + PAGE : 'PAGE NOT FOUND. Put index.html exactly here: ' + PAGE);
app.get('/', (req, res) => {
  if (fs.existsSync(PAGE)) return res.sendFile(PAGE);
  res.status(404).send('<h1>index.html not found</h1><p>Put your <b>index.html</b> in a folder named <b>public</b>, next to server.js, so the full path is:</p><pre>' + PAGE + '</pre>');
});

// Visit http://localhost:3000/api/ping to test the key from the server. Registers an empty
// file slot only, so no scan units are used.
app.get('/api/ping', async (req, res) => {
  if (process.env.PUBLIC_DEMO === '1') return res.status(404).json({ error: 'Not available' });
  try {
    const r = await api('ping', `${BASE}/s2s/v2.0/file`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ files: [{ content_type: 'image/jpeg', file_name: 'ping.jpg', file_size: 1000 }] }),
    });
    res.json({ ok: true, status: r.status, keyLength: KEY.length, keyEndsWith: KEY.slice(-4) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, code: e.code, keyLength: KEY.length, keyEndsWith: KEY.slice(-4) });
  }
});

// The browser sends { image: "data:image/jpeg;base64,..." }
app.post('/api/scan', async (req, res) => {
  try {
    if (scans >= MAX_SCANS) return res.status(429).json({ error: 'Scan limit reached for this session.' });

    const m = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec((req.body && req.body.image) || '');
    if (!m) return res.status(400).json({ error: 'Send a JPEG or PNG as a data URL.' });
    const type = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Image is over 10 MB.' });
    if (ipLimited(req, 'scan', PER_IP_SCANS)) return res.status(429).json({ error: LIMIT_MSG });
    scans++;

    // 1. Register the file
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const reg = await api('register file', `${BASE}/s2s/v2.0/file`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ files: [{ content_type: type, file_name: `scan.${ext}`, file_size: buf.length }] }),
    });
    const file = reg.data.files[0];
    const target = file.requests[0];

    // 2. Upload the bytes to the pre-signed URL (fetch sets Content-Length itself)
    const headers = { ...target.headers };
    delete headers['Content-Length'];
    delete headers['content-length'];
    const put = await fetch(target.url, { method: target.method || 'PUT', headers, body: buf });
    if (!put.ok) { console.error('[upload] HTTP', put.status); throw new Error(`upload: HTTP ${put.status}`); }

    // 3. Start the analysis
    const task = await api('start analysis', `${BASE}/s2s/v2.0/task/skin-analysis`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ src_file_id: file.file_id, dst_actions: SD, format: 'json' }),
    });
    const taskId = task.data.task_id;

    // 4. Poll until done (no units are charged while it is still running)
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const r = await api('poll result', `${BASE}/s2s/v2.0/task/skin-analysis/${encodeURIComponent(taskId)}`, { headers: auth });
      const status = r.data.task_status;
      if (status === 'success') return res.json(shape(r.data.results.output));
      if (status === 'error') {
        // YouCam reports quality problems here, e.g. error_src_face_too_small
        const e = r.data.error;
        const code = typeof e === 'string' ? e : (e && (e.code || e.error_code)) || null;
        const err = new Error(code || 'Analysis failed');
        err.code = code;
        throw err;
      }
    }
    res.status(504).json({ error: 'Analysis timed out.' });
  } catch (e) {
    // e.code carries API errors such as error_src_face_too_small or error_lighting_dark
    res.status(502).json({ error: e.message, code: e.code });
  }
});


// ---------- Try a look (AI Look Virtual Try-On, 2 units per try) ----------
const MAX_VTO = Number(process.env.MAX_VTO || 15); // protects your unit budget
let vtos = 0;
let looksCache = null;

// List of ready-made looks (cached so it only costs one call per server run)
app.get('/api/looks', async (req, res) => {
  try {
    if (!looksCache) {
      const templates = [];
      let token = null;
      for (let page = 0; page < 25; page++) {
        const url = `${BASE}/s2s/v2.0/task/template/look-vto?page_size=20` + (token ? `&starting_token=${encodeURIComponent(token)}` : '');
        const r = await api('list looks', url, { headers: auth });
        templates.push(...((r.data && r.data.templates) || []));
        token = r.data && r.data.next_token;
        if (!token) break;
      }
      looksCache = templates.map((t) => ({ id: t.id, title: t.title, category: t.category_name, thumb: t.thumb }));
    }
    res.json({ looks: looksCache });
  } catch (e) {
    res.status(502).json({ error: e.message, code: e.code });
  }
});

// The browser sends { image: "data:image/jpeg;base64,...", templateId: "..." }
app.post('/api/vto', async (req, res) => {
  try {
    if (vtos >= MAX_VTO) return res.status(429).json({ error: 'Try-on limit reached for this session.' });
    const { image, templateId } = req.body || {};
    const m = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(image || '');
    if (!m || !templateId) return res.status(400).json({ error: 'Send a JPEG or PNG data URL and a templateId.' });
    const type = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Image is over 10 MB.' });
    if (ipLimited(req, 'vto', PER_IP_VTO)) return res.status(429).json({ error: LIMIT_MSG });
    vtos++;

    const ext = type === 'image/png' ? 'png' : 'jpg';
    const reg = await api('register file', `${BASE}/s2s/v2.0/file`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ files: [{ content_type: type, file_name: `look.${ext}`, file_size: buf.length }] }),
    });
    const file = reg.data.files[0];
    const target = file.requests[0];
    const headers = { ...target.headers };
    delete headers['Content-Length'];
    delete headers['content-length'];
    const put = await fetch(target.url, { method: target.method || 'PUT', headers, body: buf });
    if (!put.ok) { console.error('[upload] HTTP', put.status); throw new Error(`upload: HTTP ${put.status}`); }

    const task = await api('start look', `${BASE}/s2s/v2.0/task/look-vto`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ src_file_id: file.file_id, template_id: templateId }),
    });
    const taskId = task.data.task_id;

    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const r = await api('poll look', `${BASE}/s2s/v2.0/task/look-vto/${encodeURIComponent(taskId)}`, { headers: auth });
      const status = r.data.task_status;
      if (status === 'success') return res.json({ url: r.data.results && r.data.results.url });
      if (status === 'error') {
        const e = r.data.error;
        const code = typeof e === 'string' ? e : (e && (e.code || e.error_code)) || null;
        const err = new Error(code || 'Look failed');
        err.code = code;
        throw err;
      }
    }
    res.status(504).json({ error: 'Try-on timed out.' });
  } catch (e) {
    res.status(502).json({ error: e.message, code: e.code });
  }
});

app.listen(PORT, () => {
  console.log(`Cleo's Makeover running at http://localhost:${PORT}`);
  console.log(`Key test page: http://localhost:${PORT}/api/ping   (server.js v4)`);
});
