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

const MAX_GENERAL = 4000, MAX_NOTE = 1000, MAX_PAGE_NOTES = 30, MAX_ANSWER = 2000;
const LENGTH = { slides: [5, 25, 10], report: [2, 10, 4] }; // min, max, default
const RESUME = {
  answered: 'The user answered your questions: read input/answers.md and continue building; do not ask again.',
  skipped: "The user skipped the questions: continue with what you have, leave out what you can't source; do not ask again.",
};
// theme -> the formats it supports; custom (a .pptx template) is slides only and needs the job's template
const THEMES = { paper: ['report', 'slides'], midnight: ['report', 'slides'], metropolis: ['slides'], moloch: ['slides'], focus: ['slides'], trigon: ['slides'], madrid: ['slides'], custom: ['slides'] };
const COMPILE_TIMEOUT = 60000;
const jobs = new Map(); // id -> { events: [], from, clients: Set, finished }; a revision replays events from `from`
let busy = null; // ponytail: one job at a time (429 otherwise); add a queue if several users share a server
const switching = new Set(); // job ids whose theme is being recompiled

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
  const fp = input.file_path || '';
  const file = path.basename(fp);
  switch (name) {
    case 'Write':
      if (file === 'questions.json') return ['ask', 'Writing down what it needs to ask you'];
      return /\.tex$/.test(file) ? ['write', `Writing ${file}`] : /\.sty$/.test(file) ? ['theme', `Building the theme ${file}`] : ['write', `Writing ${file}`];
    case 'Edit': case 'MultiEdit': return ['edit', `Editing ${file}`];
    case 'Read': {
      const rel = fp ? path.relative(jobDir, path.resolve(jobDir, fp)) : 'file';
      const shown = rel.startsWith('..') ? file : rel;
      if (/SKILL\.md$|charts\.md$|template\.md$/.test(fp)) return ['skill', `Reading the playbook (${file})`];
      if (/\.(png|jpe?g|gif|webp)$/i.test(fp)) return ['image', `Looking at ${shown}`];
      if (/\.pdf$/i.test(fp)) return ['review', `Checking the rendered ${file}`];
      if (/\.(csv|tsv)$/i.test(fp) || file === 'facts.json') return ['data', `Reading ${shown}`];
      if (/\.(tex|sty|log)$/i.test(fp)) return ['tex', `Reading ${shown}`];
      if (/\.(md|txt|rst)$/i.test(fp) || file === 'job.json') return ['doc', `Reading ${shown}`];
      return ['code', `Reading code: ${shown}`];
    }
    case 'Glob': case 'Grep': case 'LS': return ['search', 'Looking through the inputs'];
    case 'Skill': {
      const s = input.skill || input.command || input.name || '';
      return /humaniz/i.test(s) ? ['humanize', 'Humanizing the prose'] : ['skill', `Loading the ${s || 'devreport'} playbook`];
    }
    case 'Bash': {
      const c = String(input.command || '');
      return /^\s*tectonic\b/.test(c) ? ['compile', 'Compiling with tectonic'] : ['blocked', 'Tried a shell command (only tectonic is allowed)'];
    }
    case 'TodoWrite': return ['plan', 'Planning the outline'];
    default: return ['think', `Using ${name}`];
  }
}

// opts.resume = session id to continue with opts.prompt; opts.append = a line added to the normal prompt
function runClaude(id, jobDir, vars, file = 'prompt.txt', opts = {}) {
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
  if (opts.append) prompt += '\n' + opts.append;
  if (opts.resume) prompt = opts.prompt;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', [...(opts.resume ? ['--resume', opts.resume] : []), '-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', tools],
      { cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { step(id, 'error', 'Timed out after 10 minutes'); child.kill('SIGTERM'); }, CLAUDE_TIMEOUT);
    const pending = new Map(); // tool_use_id -> icon, to phrase errors
    let buf = '', stderr = '', resultText = '', cost, note = '', sessionId;
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
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id;
          step(id, 'think', opts.resume ? 'Agent picked up where it left off' : 'Agent started');
        }
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
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'Agent CLI (claude) not found on PATH' : e.message)); });
    child.on('close', (code) => { clearTimeout(timer); flush(); resolve({ code, stderr, resultText, cost, sessionId }); });
  });
}

// ---------- pipeline ----------
async function setStatus(jobDir, status, extra = {}) {
  const f = path.join(jobDir, 'job.json');
  const j = JSON.parse(await fsp.readFile(f, 'utf8'));
  await fsp.writeFile(f, JSON.stringify({ ...j, ...extra, status }, null, 2));
}
const doneData = (id, j) => ({ pdf: `/api/jobs/${id}/main.pdf`, tex: `/api/jobs/${id}/main.tex`, kind: j.kind, version: (j.revisions || 0) + 1, theme: j.theme, template: !!j.template });

// ---------- themes ----------
// null when `theme` is allowed for job `j` ({kind, template}), else why not
function themeError(theme, j) {
  if (typeof theme !== 'string' || !Object.hasOwn(THEMES, theme)) return 'Unknown theme';
  if (theme === 'custom' && !j.template) return 'This job has no PowerPoint template';
  if (!THEMES[theme].includes(j.kind)) return `${theme[0].toUpperCase() + theme.slice(1)} is a slides theme; reports come in Paper or Midnight`;
  return null;
}
// main.tex only says \input{theme.tex}; this one line picks the theme
const themeTex = (theme) => `\\usepackage{${theme === 'custom' ? 'template/devreport-custom' : `../../.claude/skills/devreport/themes/devreport-${theme}`}}\n`;
const writeThemeTex = (jobDir, theme) => fsp.writeFile(path.join(jobDir, 'theme.tex'), themeTex(theme));
// older jobs named the theme in main.tex: point that line at theme.tex instead. false if there's no theme line at all
function useThemeTex(tex) {
  if (/^\s*\\input\{theme(\.tex)?\}/m.test(tex)) return tex;
  const re = /^\s*\\usepackage\{(?:\.\.\/\.\.\/\.claude\/skills\/devreport\/themes\/devreport-[a-z]+|template\/devreport-custom)\}[ \t]*$/m;
  return re.test(tex) ? tex.replace(re, '\\input{theme.tex}') : false;
}

// runs fn; any throw marks the job failed. Releases the busy guard either way
async function guarded(id, jobDir, fn) {
  try { await fn(); } catch (e) {
    await setStatus(jobDir, 'failed').catch(() => {});
    emit(id, 'failed', { error: e.message });
  } finally {
    busy = null;
  }
}

const unit = (kind) => (kind === 'slides' ? 'slides' : 'pages');
function parseLength(raw, kind) {
  const [min, max, def] = LENGTH[kind];
  if (raw == null || raw === '') return def;
  if (!/^\d+$/.test(String(raw)) || +raw < min || +raw > max) throw new Error(`Length must be a whole number from ${min} to ${max} ${unit(kind)}`);
  return +raw;
}

// questions.json is written by Claude from untrusted input: keep only well-formed, short questions
function parseQuestions(txt) {
  let q; try { q = JSON.parse(txt).questions; } catch { return []; }
  if (!Array.isArray(q)) return [];
  const seen = new Set();
  return q.filter((x) => x && /^q\d$/.test(x.id) && !seen.has(x.id) && seen.add(x.id) && typeof x.question === 'string' && x.question.trim())
    .slice(0, 3).map((x) => ({ id: x.id, question: x.question.trim().slice(0, 300), why: typeof x.why === 'string' ? x.why.trim().slice(0, 200) : '' }));
}

// {answers:{q1:"..."}} or {skip:true} -> {skip} | {answers:[{question, answer}]}; throws on anything malformed
function parseAnswers(buf, questions) {
  let b; try { b = JSON.parse(buf); } catch { throw new Error('Body must be JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Body must be a JSON object');
  if (b.skip === true) return { skip: true };
  if (!b.answers || typeof b.answers !== 'object' || Array.isArray(b.answers)) throw new Error('Send {answers:{q1:"..."}} or {skip:true}');
  for (const [k, v] of Object.entries(b.answers)) {
    if (!questions.some((q) => q.id === k)) throw new Error(`Unknown question ${k.slice(0, 20)}`);
    if (typeof v !== 'string') throw new Error('Each answer must be a string');
    if (v.length > MAX_ANSWER) throw new Error(`An answer is over ${MAX_ANSWER} characters`);
  }
  const answers = questions.map((q) => ({ question: q.question, answer: (b.answers[q.id] || '').trim() })).filter((a) => a.answer);
  if (!answers.length) throw new Error('Answer at least one question, or skip');
  return { answers };
}

// one claude run, then: done, or waiting on questions (first run only), or a throw
async function build(id, jobDir, j, resumeLine) {
  const vars = { kind: j.kind, theme: j.theme, length: `${j.length || LENGTH[j.kind][2]} ${unit(j.kind)}` };
  let r = j.sessionId && resumeLine ? await runClaude(id, jobDir, vars, 'prompt.txt', { resume: j.sessionId, prompt: resumeLine }) : null;
  if (resumeLine && !r?.sessionId) { // the session is gone: start over with the normal prompt plus the line
    if (r) step(id, 'think', 'The earlier session is gone, starting a fresh run');
    r = await runClaude(id, jobDir, vars, 'prompt.txt', { append: resumeLine });
  }
  r ||= await runClaude(id, jobDir, vars);
  const { code, stderr, resultText, cost, sessionId } = r;
  const qf = path.join(jobDir, 'questions.json');
  if (!fs.existsSync(path.join(jobDir, 'main.pdf'))) {
    const questions = !resumeLine && fs.existsSync(qf) ? parseQuestions(await fsp.readFile(qf, 'utf8')) : [];
    if (questions.length) {
      await setStatus(jobDir, 'waiting', { sessionId, asked: true, askCost: cost });
      emit(id, 'questions', { questions });
      return;
    }
    throw new Error(`The agent finished without a PDF (exit ${code}). ${(resultText || stderr).trim().slice(0, 300)}`);
  }
  await fsp.rm(qf, { force: true });
  await setStatus(jobDir, 'done', { sessionId });
  emit(id, 'done', { ...doneData(id, j), cost: cost + (j.askCost || 0) || cost });
}

function pipeline(id, jobDir, { zips, repoUrl, template }, j) {
  const inputDir = path.join(jobDir, 'input');
  return guarded(id, jobDir, async () => {
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

    step(id, 'think', `Handing off to the agent (${j.kind}, ${j.theme} theme, about ${j.length} ${unit(j.kind)})`);
    await build(id, jobDir, j);
  });
}

async function answerJob(req, res, id) {
  const jobDir = path.join(JOBS, id);
  let j; try { j = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8')); } catch { return json(res, 404, { error: 'No such job' }); }
  if (busy) return json(res, 409, { error: 'A report is being generated or revised. Try again when it finishes.' });
  if (j.status !== 'waiting') return json(res, 409, { error: 'This job is not waiting for answers' });
  if (+req.headers['content-length'] > 16 * 1024) return json(res, 413, { error: 'Answers are too long' });
  busy = id;
  let got;
  try {
    const questions = parseQuestions(await fsp.readFile(path.join(jobDir, 'questions.json'), 'utf8').catch(() => ''));
    got = parseAnswers(await readBody(req, 16 * 1024, 'Answers are too long'), questions);
  } catch (e) { busy = null; return json(res, e.status || 400, { error: e.message }); }
  if (got.answers) await fsp.writeFile(path.join(jobDir, 'input', 'answers.md'), got.answers.map((a) => `## ${a.question}\n\n${a.answer}\n`).join('\n'));
  await fsp.rm(path.join(jobDir, 'questions.json'), { force: true });
  await setStatus(jobDir, 'running');
  if (!jobs.has(id)) jobs.set(id, { events: [], clients: new Set() }); // server restarted while waiting
  jobs.get(id).finished = false;
  json(res, 202, { ok: true });
  const n = got.answers?.length;
  step(id, 'answer', n ? `Got ${n} answer${n === 1 ? '' : 's'}, continuing` : 'Skipped the questions, continuing with what there is');
  guarded(id, jobDir, () => build(id, jobDir, j, n ? RESUME.answered : RESUME.skipped));
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
  if (busy || switching.has(id)) return json(res, 409, { error: 'A report is being generated, revised or re-themed. Try again when it finishes.' });
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

// ---------- instant theme switch: write theme.tex, run tectonic directly (no Claude) ----------
// themes/<name>.pdf caches each compiled theme; themes/key holds a hash of main.tex (+ the custom .sty), so a revision invalidates it
async function switchTheme(req, res, id) {
  const jobDir = path.join(JOBS, id), tex = path.join(jobDir, 'main.tex'), pdf = path.join(jobDir, 'main.pdf'), cache = path.join(jobDir, 'themes');
  let j; try { j = JSON.parse(await fsp.readFile(path.join(jobDir, 'job.json'), 'utf8')); } catch { return json(res, 404, { error: 'No such job' }); }
  if (busy === id || switching.has(id) || j.status !== 'done' || !fs.existsSync(pdf) || !fs.existsSync(tex))
    return json(res, 409, { error: 'The theme can only change on a finished PDF that is not being revised' });
  let theme;
  try { theme = JSON.parse(await readBody(req, 1024, 'Body is too long')).theme; } catch (e) { return json(res, e.status || 400, { error: e.status ? e.message : 'Body must be JSON' }); }
  const bad = themeError(theme, j);
  if (bad) return json(res, 400, { error: bad });
  const started = Date.now(), url = () => `/api/jobs/${id}/main.pdf?v=${Date.now()}`;
  if (theme === j.theme) return json(res, 200, { theme, pdf: url(), ms: 0, cached: true });
  switching.add(id);
  const oldThemeTex = await fsp.readFile(path.join(jobDir, 'theme.tex'), 'utf8').catch(() => null), oldPdf = await fsp.readFile(pdf);
  try {
    const src = await fsp.readFile(tex, 'utf8'), fixed = useThemeTex(src);
    if (fixed === false) throw Object.assign(new Error("This document doesn't load its theme through theme.tex"), { status: 409 });
    if (fixed !== src) await fsp.writeFile(tex, fixed);
    const sty = await fsp.readFile(path.join(jobDir, 'template', 'devreport-custom.sty'), 'utf8').catch(() => '');
    const key = crypto.createHash('sha1').update(fixed).update('\0').update(sty).digest('hex');
    if ((await fsp.readFile(path.join(cache, 'key'), 'utf8').catch(() => '')) !== key) {
      await fsp.rm(cache, { recursive: true, force: true });
      await fsp.mkdir(cache);
      await fsp.writeFile(path.join(cache, 'key'), key);
    }
    await fsp.writeFile(path.join(cache, `${j.theme}.pdf`), oldPdf); // switching back is a copy
    const hit = path.join(cache, `${theme}.pdf`), cached = fs.existsSync(hit);
    await writeThemeTex(jobDir, theme);
    if (cached) await fsp.copyFile(hit, pdf);
    else {
      try { await run('tectonic', ['main.tex'], { cwd: jobDir, timeout: COMPILE_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }); }
      catch (e) {
        const why = e.killed ? `timed out after ${COMPILE_TIMEOUT / 1000} s` : (String(e.stderr || '').split('\n').find((l) => /^error|^!/.test(l)) || e.message).trim().slice(0, 300);
        throw Object.assign(new Error(`It didn't compile in ${theme}: ${why}`), { status: 422 });
      }
      await fsp.copyFile(pdf, hit);
    }
    await setStatus(jobDir, 'done', { theme });
    const ev = jobs.get(id)?.events.findLast((e) => e.type === 'done'); // a reload replays this event
    if (ev) ev.data.theme = theme;
    json(res, 200, { theme, pdf: url(), ms: Date.now() - started, cached });
  } catch (e) {
    if (oldThemeTex !== null) await fsp.writeFile(path.join(jobDir, 'theme.tex'), oldThemeTex).catch(() => {});
    await fsp.writeFile(pdf, oldPdf).catch(() => {});
    json(res, e.status || 500, { error: e.message });
  } finally {
    switching.delete(id);
  }
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
    const theme = pptx ? 'custom' : fields.theme && fields.theme !== 'custom' ? fields.theme : 'paper';
    const bad = themeError(theme, { kind, template: !!pptx });
    if (bad) throw new Error(bad);
    const repoUrl = normalizeRepoUrl(fields.repoUrl);
    const length = parseLength(fields.length, kind);
    const inputs = files.filter((f) => f.name !== 'template');
    if (!inputs.length && !repoUrl) throw new Error('Add some files, a zip or a GitHub URL');

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const jobDir = path.join(JOBS, id), inputDir = path.join(jobDir, 'input');
    await fsp.mkdir(inputDir, { recursive: true });
    const j = { id, kind, theme, length, ...(pptx && { template: true }), status: 'queued', createdAt: new Date().toISOString() };
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(j, null, 2));
    await writeThemeTex(jobDir, theme);
    if (pptx) await fsp.writeFile(path.join(jobDir, 'template.pptx'), pptx.data);

    const taken = new Set(), zips = [];
    for (const f of inputs) {
      const name = safeName(f.filename, taken);
      await fsp.writeFile(path.join(inputDir, name), f.data);
      if (/\.zip$/i.test(name)) zips.push(name);
    }

    jobs.set(id, { events: [], clients: new Set(), finished: false });
    busy = id;
    const got = [inputs.length && `${inputs.length} file${inputs.length === 1 ? '' : 's'}`, repoUrl && 'a GitHub link'].filter(Boolean).join(' and ');
    step(id, 'upload', `Received ${got}`);
    json(res, 201, { id });
    pipeline(id, jobDir, { zips, repoUrl, template: pptx && path.basename(pptx.filename) }, j);
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
    if (j.status === 'waiting') {
      let questions = []; try { questions = parseQuestions(fs.readFileSync(path.join(JOBS, id, 'questions.json'), 'utf8')); } catch {}
      if (questions.length) { send(res, { type: 'questions', data: { questions, t: Date.now() } }); return res.end(); }
    }
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

function serveFile(res, file, type, cache = 'no-store') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
  if (req.method === 'POST' && p === '/api/jobs') return createJob(req, res);
  const pv = /^\/previews\/([a-z]+)((?:-report)?(?:\.png|-[1-4]\.jpg))$/.exec(p); // theme thumbnails (.png) and preview pages (-N.jpg) for the pickers
  if (req.method === 'GET' && pv && Object.hasOwn(THEMES, pv[1])) return serveFile(res, path.join(ROOT, '.claude/skills/devreport/themes/previews', pv[1] + pv[2]), pv[2].endsWith('.png') ? 'image/png' : 'image/jpeg', 'max-age=3600');
  const r = /^\/api\/jobs\/([^/]+)\/(revise|answers|theme)$/.exec(p);
  if (req.method === 'POST' && r) return !ID_RE.test(r[1]) ? json(res, 400, { error: 'Bad job id' }) : { revise: reviseJob, answers: answerJob, theme: switchTheme }[r[2]](req, res, r[1]);
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
module.exports = { parseMultipart, normalizeRepoUrl, describeTool, parseRevision, parseLength, parseQuestions, parseAnswers, THEMES, themeError, themeTex, useThemeTex };
