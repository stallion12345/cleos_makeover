const express = require('express');
const serverless = require('serverless-http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '12mb' }));

function loadLocalDotEnv() {
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '..', '.env.example'),
  ];

  for (const envPath of candidates) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
      raw.split(/\r?\n/).forEach((line) => {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (match && !line.trim().startsWith('#')) {
          process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
        }
      });
      return;
    } catch (error) {
      // Keep trying .env, then .env.example when deployed without a real .env.
    }
  }
}

loadLocalDotEnv();

const KEY = (process.env.YOUCAM_API_KEY || '')
  .trim()
  .replace(/^['"]|['"]$/g, '')
  .replace(/^Bearer\s+/i, '')
  .trim();

const BASE = process.env.YOUCAM_BASE || 'https://yce-api-01.makeupar.com';
const MAX_SCANS = Number(process.env.MAX_SCANS || 40);
const MAX_VTO = Number(process.env.MAX_VTO || 15);
const PER_IP_SCANS = Number(process.env.PER_IP_SCANS || 6);
const PER_IP_VTO = Number(process.env.PER_IP_VTO || 12);

const SD = [
  'wrinkle', 'droopy_upper_eyelid', 'droopy_lower_eyelid', 'firmness', 'acne',
  'moisture', 'eye_bag', 'dark_circle_v2', 'age_spot', 'radiance', 'redness',
  'oiliness', 'pore', 'texture', 'tear_trough', 'skin_type',
];

const auth = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.ip || 'unknown';
}

const ipHits = {};
function ipLimited(req, kind, max) {
  const now = Date.now();
  const ip = getClientIp(req);
  const key = `${kind}:${ip}`;
  const recent = (ipHits[key] = (ipHits[key] || []).filter((t) => now - t < 24 * 36e5));
  if (recent.length >= max) return true;
  recent.push(now);
  ipHits[key] = recent;
  return false;
}

const LIMIT_MSG = 'The demo limit for this connection has been reached. Please watch the video, or run the project locally with your own YouCam key.';

async function api(label, url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.status && body.status !== 200)) {
    const errorMessage = `${label}: ${body.error || 'HTTP ' + res.status}`;
    const err = new Error(errorMessage);
    err.code = body.error_code || body.code;
    throw err;
  }
  return body;
}

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

function buildKeyHeader() {
  return {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  };
}

app.get('/api/ping', async (req, res) => {
  try {
    if (!KEY) {
      return res.status(500).json({ ok: false, error: 'Missing YOUCAM_API_KEY in Netlify environment variables.' });
    }
    const r = await api('ping', `${BASE}/s2s/v2.0/file`, {
      method: 'POST',
      headers: buildKeyHeader(),
      body: JSON.stringify({ files: [{ content_type: 'image/jpeg', file_name: 'ping.jpg', file_size: 1000 }] }),
    });
    res.json({ ok: true, status: r.status, keyLength: KEY.length, keyEndsWith: KEY.slice(-4) });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message, code: error.code, keyLength: KEY.length, keyEndsWith: KEY.slice(-4) });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    if (!KEY) {
      return res.status(500).json({ error: 'Missing YOUCAM_API_KEY in Netlify environment variables.' });
    }

    if (ipLimited(req, 'scan', PER_IP_SCANS)) {
      return res.status(429).json({ error: LIMIT_MSG });
    }

    const image = req.body && req.body.image;
    const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(image || '');
    if (!match) {
      return res.status(400).json({ error: 'Send a JPEG or PNG as a data URL.' });
    }

    const type = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is over 10 MB.' });
    }

    const ext = type === 'image/png' ? 'png' : 'jpg';
    const reg = await api('register file', `${BASE}/s2s/v2.0/file`, {
      method: 'POST',
      headers: buildKeyHeader(),
      body: JSON.stringify({ files: [{ content_type: type, file_name: `scan.${ext}`, file_size: buffer.length }] }),
    });

    const file = reg.data.files[0];
    const target = file.requests[0];
    const headers = { ...target.headers };
    delete headers['Content-Length'];
    delete headers['content-length'];

    const uploadResponse = await fetch(target.url, {
      method: target.method || 'PUT',
      headers,
      body: buffer,
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => '');
      throw new Error(`upload: HTTP ${uploadResponse.status} ${text}`);
    }

    const task = await api('start analysis', `${BASE}/s2s/v2.0/task/skin-analysis`, {
      method: 'POST',
      headers: buildKeyHeader(),
      body: JSON.stringify({ src_file_id: file.file_id, dst_actions: SD, format: 'json' }),
    });

    const taskId = task.data.task_id;
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const statusResponse = await api('poll result', `${BASE}/s2s/v2.0/task/skin-analysis/${encodeURIComponent(taskId)}`, {
        headers: buildKeyHeader(),
      });
      const status = statusResponse.data.task_status;
      if (status === 'success') return res.json(shape(statusResponse.data.results.output));
      if (status === 'error') {
        const e = statusResponse.data.error;
        const code = typeof e === 'string' ? e : (e && (e.code || e.error_code)) || null;
        const err = new Error(code || 'Analysis failed');
        err.code = code;
        throw err;
      }
    }

    res.status(504).json({ error: 'Analysis timed out.' });
  } catch (error) {
    res.status(502).json({ error: error.message, code: error.code });
  }
});

let looksCache = null;
app.get('/api/looks', async (req, res) => {
  try {
    if (!KEY) {
      return res.status(500).json({ error: 'Missing YOUCAM_API_KEY in Netlify environment variables.' });
    }
    if (!looksCache) {
      const templates = [];
      let token = null;
      for (let page = 0; page < 25; page++) {
        const url = `${BASE}/s2s/v2.0/task/template/look-vto?page_size=20${token ? `&starting_token=${encodeURIComponent(token)}` : ''}`;
        const result = await api('list looks', url, { headers: buildKeyHeader() });
        templates.push(...((result.data && result.data.templates) || []));
        token = result.data && result.data.next_token;
        if (!token) break;
      }
      looksCache = templates.map((template) => ({
        id: template.id,
        title: template.title,
        category: template.category_name,
        thumb: template.thumb,
      }));
    }
    res.json({ looks: looksCache });
  } catch (error) {
    res.status(502).json({ error: error.message, code: error.code });
  }
});

app.post('/api/vto', async (req, res) => {
  try {
    if (!KEY) {
      return res.status(500).json({ error: 'Missing YOUCAM_API_KEY in Netlify environment variables.' });
    }

    if (ipLimited(req, 'vto', PER_IP_VTO)) {
      return res.status(429).json({ error: LIMIT_MSG });
    }

    const { image, templateId } = req.body || {};
    if (!image || !templateId) {
      return res.status(400).json({ error: 'Send a JPEG or PNG data URL and a templateId.' });
    }

    const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(image || '');
    if (!match) {
      return res.status(400).json({ error: 'Send a JPEG or PNG data URL and a templateId.' });
    }

    const type = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is over 10 MB.' });
    }

    const ext = type === 'image/png' ? 'png' : 'jpg';
    const reg = await api('register file', `${BASE}/s2s/v2.0/file`, {
      method: 'POST',
      headers: buildKeyHeader(),
      body: JSON.stringify({ files: [{ content_type: type, file_name: `look.${ext}`, file_size: buffer.length }] }),
    });

    const file = reg.data.files[0];
    const target = file.requests[0];
    const headers = { ...target.headers };
    delete headers['Content-Length'];
    delete headers['content-length'];

    const uploadResponse = await fetch(target.url, {
      method: target.method || 'PUT',
      headers,
      body: buffer,
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => '');
      throw new Error(`upload: HTTP ${uploadResponse.status} ${text}`);
    }

    const task = await api('start look', `${BASE}/s2s/v2.0/task/look-vto`, {
      method: 'POST',
      headers: buildKeyHeader(),
      body: JSON.stringify({ src_file_id: file.file_id, template_id: templateId }),
    });

    const taskId = task.data.task_id;
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const statusResponse = await api('poll look', `${BASE}/s2s/v2.0/task/look-vto/${encodeURIComponent(taskId)}`, {
        headers: buildKeyHeader(),
      });
      const status = statusResponse.data.task_status;
      if (status === 'success') return res.json({ url: statusResponse.data.results && statusResponse.data.results.url });
      if (status === 'error') {
        const e = statusResponse.data.error;
        const code = typeof e === 'string' ? e : (e && (e.code || e.error_code)) || null;
        const err = new Error(code || 'Look failed');
        err.code = code;
        throw err;
      }
    }

    res.status(504).json({ error: 'Try-on timed out.' });
  } catch (error) {
    res.status(502).json({ error: error.message, code: error.code });
  }
});

module.exports = { handler: serverless(app) };
