// devreport server: uploads -> jobs/<id>/ -> collect.js -> claude -p -> SSE progress -> PDF
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const ROOT = __dirname;
const JOBS = path.join(ROOT, 'jobs');
const PORT = +process.env.PORT || 3000;
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_UNZIPPED = 200 * 1024 * 1024;
const CLAUDE_TIMEOUT = 10 * 60 * 1000;
const ID_RE = /^[0-9a-f]{8}$/;
const DEFAULT_TOOLS = 'Read,Write,Edit,Bash(tectonic:*),Skill';
const DEFAULT_PROMPT = 'Follow the devreport skill. Build a {{kind}} with the {{theme}} theme from the inputs in this folder (facts.json, data/, images/, input/). Write main.tex and compile it to main.pdf with tectonic, fixing errors until it compiles.';

const MAX_GENERAL = 4000, MAX_NOTE = 1000, MAX_PAGE_NOTES = 30;
const jobs = new Map(); // id -> { events: [], from, clients: Set, finished }; a revision replays events from `from`
let busy = null; // ponytail: one job at a time (429 otherwise); add a queue if several users share a server

// ---------- events ----------
function emit(id, type, data) {
  const job = jobs.get(id);
  const ev = { type, data: { ...data, t: Date.now() } };
  job.events.push(ev);
  for (const res of job.clients) send(res, ev);
  if (type === 'done' || type === 'failed') {
    job.finished = true;
    for (const res of job.clients) res.end();
    job.clients.clear();
  }
}
const send = (res, ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
const step = (id, icon, text) => emit(id, 'step', { icon, text });

// ---------- multipart ----------
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Expected multipart/form-data');
  const delim = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}, files = [];
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break; // closing delimiter
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const next = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd);
    if (next === -1) break;
    const head = buf.slice(start + 2, headEnd).toString('utf8');
    const body = buf.slice(headEnd + 4, next);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (filename !== undefined) { if (filename) files.push({ name, filename, data: body }); }
    else if (name) fields[name] = body.toString('utf8');
    pos = next + 2;
  }
  return { fields, files };
}

// ---------- intake helpers ----------
function safeName(name, taken) {
  let base = path.basename(name.replace(/\\/g, '/')).replace(/[^\w.-]/g, '_').replace(/^\.+/, '') || 'file';
  base = base.slice(-100);
  let out = base, i = 1;
  while (taken.has(out.toLowerCase()) || ['answers.md', 'repo'].includes(out.toLowerCase())) out = `${i++}_${base}`;
  taken.add(out.toLowerCase());
  return out;
}

function normalizeRepoUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  u = u.replace(/\/tree\/.*$/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(u) || /\/\.\.?(\/|$)/.test(u)) throw new Error('Not a public GitHub repo URL (https://github.com/owner/repo)');
  return u;
}

async function unzipInto(zipPath, inputDir) {
  const { stdout } = await run('unzip', ['-l', zipPath], { maxBuffer: 64 * 1024 * 1024 });
  const total = +(stdout.trim().split('\n').pop().trim().split(/\s+/)[0]);
  if (!Number.isFinite(total)) throw new Error('Could not read zip listing');
  if (total > MAX_UNZIPPED) throw new Error(`Zip expands to ${(total / 1e6).toFixed(0)} MB (limit 200 MB)`);
  const { stdout: names } = await run('unzip', ['-Z1', zipPath], { maxBuffer: 64 * 1024 * 1024 });
  const dest = path.join(inputDir, path.basename(zipPath).replace(/\.zip$/i, '') || 'zip');
  // symlink entries (zipinfo mode starts with 'l'); an entry written *through* one could land outside input/
  const { stdout: long } = await run('unzip', ['-Z', zipPath], { maxBuffer: 64 * 1024 * 1024 });
  const links = long.split('\n').map((l) => /^l\S*(?:\s+\S+){7}\s+(.+)$/.exec(l)?.[1]).filter(Boolean);
  for (const n of names.split('\n').filter(Boolean)) {
    const p = path.resolve(dest, n);
    if (path.isAbsolute(n) || !p.startsWith(inputDir + path.sep) || links.some((l) => n.startsWith(l.replace(/\/?$/, '/'))))
      throw new Error(`Zip entry escapes the job folder: ${n}`);
  }
  await run('unzip', ['-q', '-o', zipPath, '-d', dest], { timeout: 60000 });
  await fsp.rm(zipPath);
  return path.relative(inputDir, dest);
}

// ---------- claude stream-json -> human steps ----------
function describeTool(name, input = {}, jobDir = '.') {
  const file = input.file_path ? path.basename(input.file_path) : '';
  switch (name) {
    case 'Write': return ['write', `Writing ${file}`];
    case 'Edit': case 'MultiEdit': return ['write', `Editing ${file}`];
    case 'Read': {
      const rel = input.file_path ? path.relative(jobDir, path.resolve(jobDir, input.file_path)) : 'file';
      return ['read', `Reading ${rel.startsWith('..') ? path.basename(rel) : rel}`];
    }
    case 'Glob': case 'Grep': case 'LS': return ['read', 'Looking through the inputs'];
    case 'Skill': {
      const s = input.skill || input.command || input.name || '';
      return /humaniz/i.test(s) ? ['humanize', 'Humanizing prose'] : ['read', `Loading ${s || 'a'} skill`];
    }
    case 'Bash': {
      const c = String(input.command || '');
      return /^\s*tectonic\b/.test(c) ? ['compile', 'Compiling with tectonic'] : ['think', `Tried a shell command (only tectonic is allowed)`];
    }
    case 'TodoWrite': return ['think', 'Planning the outline'];
    default: return ['think', `Using ${name}`];
  }
}

function runClaude(id, jobDir, vars, file = 'prompt.txt') {
  let tools = DEFAULT_TOOLS, prompt = DEFAULT_PROMPT;
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.claude/skills/devreport', file), 'utf8');
    const [first, ...rest] = txt.split('\n');
    const m = /^ALLOWED_TOOLS=(.+)$/.exec(first.trim());
    if (m) { tools = m[1].trim(); prompt = rest.join('\n').trim(); } else prompt = txt.trim();
  } catch {
    if (file !== 'prompt.txt') return Promise.reject(new Error(`${file} is missing`));
    step(id, 'think', 'No prompt.txt found, using the default prompt');
  }
  for (const [k, v] of Object.entries(vars)) prompt = prompt.replaceAll(`{{${k}}}`, v);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', tools],
      { cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { step(id, 'error', 'Timed out after 10 minutes'); child.kill('SIGTERM'); }, CLAUDE_TIMEOUT);
    const pending = new Map(); // tool_use_id -> icon, to phrase errors
    let buf = '', stderr = '', resultText = '', cost, note = '';
    // the latest assistant text is held until the next step, so the last one (the summary) can be shown in full
    const flush = (max = 140) => { if (note) step(id, 'note', note.length > max ? note.slice(0, max - 3) + '…' : note); note = ''; };
    const clean = (t) => String(t || '').trim().replace(/\*\*|`/g, '').replace(/\s+/g, ' ');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'system' && msg.subtype === 'init') step(id, 'think', 'Claude Code started');
        for (const c of msg.message?.content || []) {
          if (msg.type === 'assistant' && c.type === 'tool_use') {
            const [icon, text] = describeTool(c.name, c.input, jobDir);
            pending.set(c.id, icon);
            flush(); step(id, icon, text);
          } else if (msg.type === 'assistant' && c.type === 'text' && c.text.trim()) {
            flush(); note = clean(c.text);
          } else if (msg.type === 'user' && c.type === 'tool_result' && c.is_error) {
            step(id, 'error', pending.get(c.tool_use_id) === 'compile' ? 'Compile error, fixing' : 'A step failed, retrying');
          }
        }
        if (msg.type === 'result') { resultText = msg.result || ''; cost = msg.total_cost_usd; note = clean(resultText) || note; flush(600); }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'claude CLI not found on PATH' : e.message)); });
    child.on('close', (code) => { clearTimeout(timer); flush(); resolve({ code, stderr, resultText, cost }); });
  });
}

// ---------- pipeline ----------
async function setStatus(jobDir, status, extra = {}) {
  const f = path.join(jobDir, 'job.json');
  const j = JSON.parse(await fsp.readFile(f, 'utf8'));
  await fsp.writeFile(f, JSON.stringify({ ...j, ...extra, status }, null, 2));
}
const doneData = (id, j) => ({ pdf: `/api/jobs/${id}/main.pdf`, tex: `/api/jobs/${id}/main.tex`, kind: j.kind, version: (j.revisions || 0) + 1 });

async function pipeline(id, jobDir, { zips, repoUrl, kind, theme, template }) {
  const inputDir = path.join(jobDir, 'input');
  try {
    await setStatus(jobDir, 'running');
    for (const z of zips) {
      step(id, 'zip', `Unpacking ${z}`);
      const dir = await unzipInto(path.join(inputDir, z), inputDir);
      step(id, 'zip', `Unpacked into input/${dir}/`);
    }
    if (repoUrl) {
      step(id, 'clone', `Cloning ${repoUrl.replace('https://github.com/', '')}`);
      try {
        await run('git', ['clone', '--single-branch', '--', repoUrl, path.join(inputDir, 'repo')], {
          timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        });
      } catch (e) {
        throw new Error(e.killed ? 'Clone timed out after 60 s' : 'Clone failed: is the repo public and spelled right?');
      }
      step(id, 'clone', 'Repository cloned');
    }
    await run('find', [inputDir, '-type', 'l', '-delete']); // no symlinks out of the job folder

    const collect = path.join(ROOT, 'collect.js');
    if (!fs.existsSync(collect)) throw new Error('collect.js is missing, so there is no data to chart');
    step(id, 'collect', 'Crunching commits, logs and notes into CSVs');
    try { await run(process.execPath, [collect, jobDir], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }); }
    catch (e) { throw new Error('collect.js failed: ' + String(e.stderr || e.message).trim().split('\n').pop()); }
    try {
      const facts = JSON.parse(await fsp.readFile(path.join(jobDir, 'facts.json'), 'utf8'));
      const n = facts.charts?.length || 0, r = facts.repo;
      step(id, 'collect', `Found ${r ? r.commits + ' commits, ' : ''}${n} chart${n === 1 ? '' : 's'} worth of data`);
    } catch { /* facts summary is cosmetic */ }

    if (template) {
      step(id, 'template', `Reading your template ${template}`);
      let t;
      try {
        await run(process.execPath, [path.join(ROOT, 'pptx.js'), path.join(jobDir, 'template.pptx'), path.join(jobDir, 'template')], { timeout: 60000 });
        t = JSON.parse(await fsp.readFile(path.join(jobDir, 'template', 'template.json'), 'utf8'));
      } catch (e) { throw new Error('Template: ' + String(e.stderr || e.message).trim().split('\n').pop()); }
      const fonts = [...new Set([t.fonts.major?.name, t.fonts.minor?.name].filter(Boolean))].join(' / ') || 'no fonts';
      step(id, 'template', `Template: ${Object.keys(t.colors).length} colours, ${fonts}, ${t.media.length} image${t.media.length === 1 ? '' : 's'}`);
    }

    step(id, 'think', `Handing off to Claude Code (${kind}, ${theme} theme)`);
    const { code, stderr, resultText, cost } = await runClaude(id, jobDir, { kind, theme });
    if (!fs.existsSync(path.join(jobDir, 'main.pdf'))) {
      throw new Error(`Claude finished without a PDF (exit ${code}). ${(resultText || stderr).trim().slice(0, 300)}`);
    }
    await setStatus(jobDir, 'done');
    emit(id, 'done', { ...doneData(id, { kind }), cost });
  } catch (e) {
    await setStatus(jobDir, 'failed').catch(() => {});
    emit(id, 'failed', { error: e.message });
  } finally {
    busy = null;
  }
}

// ---------- revisions ----------
// {general, pages:[{page, note}]} -> trimmed copy; throws on anything malformed
function parseRevision(buf) {
  let b; try { b = JSON.parse(buf); } catch { throw new Error('Body must be JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Body must be a JSON object');
  const general = b.general ?? '', list = b.pages ?? [];
  if (typeof general !== 'string') throw new Error('general must be a string');
  if (general.length > MAX_GENERAL) throw new Error(`General feedback is over ${MAX_GENERAL} characters`);
  if (!Array.isArray(list)) throw new Error('pages must be an array');
  if (list.length > MAX_PAGE_NOTES) throw new Error(`At most ${MAX_PAGE_NOTES} page notes`);
  const pages = list.map((p) => {
    if (!p || !Number.isInteger(p.page) || p.page < 1 || p.page > 999) throw new Error('Page numbers must be whole numbers from 1 to 999');
    if (typeof p.note !== 'string') throw new Error('Each page note must be a string');
    if (p.note.length > MAX_NOTE) throw new Error(`A page note is over ${MAX_NOTE} characters`);
    return { page: p.page, note: p.note.trim() };
  }).filter((p) => p.note).sort((a, b) => a.page - b.page);
  if (!general.trim() && !pages.length) throw new Error('Say what should change');
  return { general: general.trim(), pages };
}

async function revise(id, jobDir, n, j, { general, pages }) {
  const rev = path.join(jobDir, 'revisions'), tex = path.join(jobDir, 'main.tex'), pdf = path.join(jobDir, 'main.pdf');
  const backTex = path.join(rev, `v${n}.tex`), backPdf = path.join(rev, `v${n}.pdf`);
  try {
    await setStatus(jobDir, 'running');
    await fsp.mkdir(rev, { recursive: true });
    await fsp.copyFile(tex, backTex);
    await fsp.copyFile(pdf, backPdf);
    const what = j.kind === 'slides' ? 'deck' : 'report';
    await fsp.writeFile(path.join(rev, `r${n}.md`), `# Revision ${n}\n\n`
      + (general ? `## Whole ${what}\n\n${general}\n\n` : '') + pages.map((p) => `## Page ${p.page}\n\n${p.note}\n\n`).join(''));
    const asked = [general && `the whole ${what}`, pages.length && `page${pages.length === 1 ? '' : 's'} ${pages.map((p) => p.page).join(', ')}`].filter(Boolean).join(' and ');
    step(id, 'revise', `Revision ${n}: notes on ${asked}. Saved v${n} as a backup`);
    const started = Date.now();
    const { code, stderr, resultText, cost } = await runClaude(id, jobDir, { n, kind: j.kind, theme: j.theme }, 'revise.txt');
    // a changed main.tex with a stale main.pdf means the last compile failed
    const texChanged = (await fsp.readFile(tex, 'utf8')) !== (await fsp.readFile(backTex, 'utf8'));
    const stale = !fs.existsSync(pdf) || (texChanged && (await fsp.stat(pdf)).mtimeMs < started);
    if (code !== 0 || stale) throw new Error(`The revision didn't compile (exit ${code}). ${(resultText || stderr).trim().slice(0, 300)}`);
    await setStatus(jobDir, 'done', { revisions: n });
    emit(id, 'done', { ...doneData(id, { ...j, revisions: n }), cost });
  } catch (e) {
    // put the last good version back so the job stays usable
    await fsp.copyFile(backTex, tex).catch(() => {});
    await fsp.copyFile(backPdf, pdf).catch(() => {});
    await setStatus(jobDir, 'done').catch(() => {});
    emit(id, 'failed', { error: `${e.message.trim().replace(/\.?$/, '.')} Kept v${n}.`, ...doneData(id, j) });
  } finally {
    busy = null;
  }
}

async function reviseJob(req, res, id) {
  const jobDir = path.join(JOBS, id);
  let j; try { j = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8')); } catch { return json(res, 404, { error: 'No such job' }); }
  if (busy) return json(res, 409, { error: 'A report is being generated or revised. Try again when it finishes.' });
  if (j.status !== 'done' || !fs.existsSync(path.join(jobDir, 'main.pdf')) || !fs.existsSync(path.join(jobDir, 'main.tex')))
    return json(res, 409, { error: 'This job has no finished PDF to revise' });
  if (+req.headers['content-length'] > 64 * 1024) return json(res, 413, { error: 'Feedback is too long' });
  busy = id;
  let feedback;
  try { feedback = parseRevision(await readBody(req, 64 * 1024, 'Feedback is too long')); }
  catch (e) { busy = null; return json(res, e.status || 400, { error: e.message }); }
  const n = (j.revisions || 0) + 1;
  const job = jobs.get(id) || { events: [], clients: new Set() };
  Object.assign(job, { from: job.events.length, finished: false });
  jobs.set(id, job);
  json(res, 202, { revision: n, version: n + 1 });
  revise(id, jobDir, n, j, feedback);
}

// ---------- http ----------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, max = MAX_UPLOAD, tooBig = 'Upload is over 50 MB') {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error(tooBig), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function createJob(req, res) {
  if (busy) return json(res, 429, { error: 'Another report is being generated. Try again in a minute.' });
  if (+req.headers['content-length'] > MAX_UPLOAD) return json(res, 413, { error: 'Upload is over 50 MB' });
  busy = 'pending';
  try {
    const { fields, files } = parseMultipart(await readBody(req), req.headers['content-type']);
    const kind = fields.kind === 'slides' ? 'slides' : 'report';
    // a .pptx template only applies to slides; for a report it's ignored
    const pptx = kind === 'slides' && fields.theme === 'custom' ? files.find((f) => f.name === 'template') : null;
    if (pptx && !/\.pptx$/i.test(pptx.filename)) throw new Error('The template must be a .pptx file');
    const theme = pptx ? 'custom' : fields.theme === 'midnight' ? 'midnight' : 'paper';
    const repoUrl = normalizeRepoUrl(fields.repoUrl);
    const inputs = files.filter((f) => f.name !== 'template');
    if (!inputs.length && !repoUrl) throw new Error('Add some files, a zip or a GitHub URL');

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const jobDir = path.join(JOBS, id), inputDir = path.join(jobDir, 'input');
    await fsp.mkdir(inputDir, { recursive: true });
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify({ id, kind, theme, ...(pptx && { template: true }), status: 'queued', createdAt: new Date().toISOString() }, null, 2));
    if (pptx) await fsp.writeFile(path.join(jobDir, 'template.pptx'), pptx.data);

    const taken = new Set(), zips = [];
    for (const f of inputs) {
      const name = safeName(f.filename, taken);
      await fsp.writeFile(path.join(inputDir, name), f.data);
      if (/\.zip$/i.test(name)) zips.push(name);
    }
    const qs = [['What problem does it solve and who is it for?', fields.problem], ['Proudest result (and how it was measured)', fields.proud], ['What did I learn, and what was hard?', fields.learned], ["What's next?", fields.next]]
      .filter(([, a]) => a && a.trim());
    if (qs.length) await fsp.writeFile(path.join(inputDir, 'answers.md'), qs.map(([q, a]) => `## ${q}\n\n${a.trim()}\n`).join('\n'));

    jobs.set(id, { events: [], clients: new Set(), finished: false });
    busy = id;
    const got = [inputs.length && `${inputs.length} file${inputs.length === 1 ? '' : 's'}`, repoUrl && 'a GitHub link'].filter(Boolean).join(' and ');
    step(id, 'upload', `Received ${got}${qs.length ? `, ${qs.length} answer${qs.length === 1 ? '' : 's'}` : ''}`);
    json(res, 201, { id });
    pipeline(id, jobDir, { zips, repoUrl, kind, theme, template: pptx && path.basename(pptx.filename) });
  } catch (e) {
    busy = null;
    json(res, e.status || 400, { error: e.message });
  }
}

function sse(req, res, id) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const job = jobs.get(id);
  if (!job) { // server restarted: answer from disk
    let j = {}; try { j = JSON.parse(fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8')); } catch {}
    const pdf = fs.existsSync(path.join(JOBS, id, 'main.pdf'));
    send(res, pdf ? { type: 'done', data: { ...doneData(id, j), t: Date.now() } } : { type: 'failed', data: { error: 'Unknown or interrupted job' } });
    return res.end();
  }
  for (const ev of job.events.slice(job.from || 0)) send(res, ev);
  if (job.finished) return res.end();
  job.clients.add(res);
  // heartbeat: some browsers/proxies drop an SSE stream that's silent while Claude thinks
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); job.clients.delete(res); });
}

function serveFile(res, file, type) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
  if (req.method === 'POST' && p === '/api/jobs') return createJob(req, res);
  const r = /^\/api\/jobs\/([^/]+)\/revise$/.exec(p);
  if (req.method === 'POST' && r) return ID_RE.test(r[1]) ? reviseJob(req, res, r[1]) : json(res, 400, { error: 'Bad job id' });
  const m = /^\/api\/jobs\/([^/]+)\/(events|main\.pdf|main\.tex|v\d{1,3}\.pdf)$/.exec(p);
  if (req.method === 'GET' && m) {
    if (!ID_RE.test(m[1])) return json(res, 400, { error: 'Bad job id' });
    if (m[2] === 'events') return sse(req, res, m[1]);
    const dl = url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="devreport-${m[1]}.${m[2].split('.')[1]}"` } : {};
    if (dl['content-disposition']) res.setHeader('content-disposition', dl['content-disposition']);
    return serveFile(res, path.join(JOBS, m[1], m[2].startsWith('v') ? 'revisions' : '', m[2]), m[2].endsWith('pdf') ? 'application/pdf' : 'text/plain; charset=utf-8');
  }
  json(res, 404, { error: 'Not found' });
});

if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`devreport on http://127.0.0.1:${PORT}`));
module.exports = { parseMultipart, normalizeRepoUrl, describeTool, parseRevision };
