#!/usr/bin/env node
// Deterministic collector: jobs/<id>/input/** -> data/*.csv, images/, facts.json (see HANDOFF.md "Interface contract").
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_FILE = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg']); // tectonic only reliably takes these
const NOTE_MAX = 6000, NOTES_TOTAL = 30000, MAX_IMAGES = 30;
const LANGS = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.rb': 'Ruby', '.go': 'Go',
  '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP', '.lua': 'Lua',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'CSS', '.sass': 'CSS', '.vue': 'Vue', '.svelte': 'Svelte',
  '.dart': 'Dart', '.scala': 'Scala', '.r': 'R', '.jl': 'Julia', '.ex': 'Elixir', '.exs': 'Elixir',
  '.hs': 'Haskell', '.ml': 'OCaml', '.zig': 'Zig', '.sql': 'SQL', '.md': 'Markdown',
  '.tex': 'TeX', '.sty': 'TeX', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.ipynb': 'Jupyter',
};
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|bun\.lockb)$/;
const GENERATED = /(\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|target|out|__pycache__|\.venv|venv|\.next|node_modules|\.claude\/skills)\/)/;
const vendored = p => LOCKFILES.test(p) || GENERATED.test(p);
const MAX_MILESTONES = 8, MAX_CODE_FILES = 40, MAX_ENTRY = 8;
const NOT_CODE = new Set(['Markdown', 'JSON', 'YAML', 'TOML']);
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)[.-][^/]+$|(^|\/)test_[^/]+$|(^|\/)test\.[^/]+$/i;
const ENTRY_NAME = /^(main|app|server|index|cli|__main__|client|run|manage)$/i;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

// ---------- helpers ----------
// pgfplots ignores CSV quoting, so strip commas/quotes/newlines from cells instead of quoting them
const csvCell = v => (v == null ? '' : String(v)).replace(/[,\n\r]+/g, ' ').replace(/"/g, "'");
function writeCsv(dir, name, header, rows) {
  fs.writeFileSync(path.join(dir, name), [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n');
  return rows.length;
}
function readText(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch { return null; }
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
const slug = s => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'data';

// Walk input/, returning files (relative to jobDir) and repo roots (dirs containing .git).
function walk(jobDir) {
  const files = [], repos = [];
  (function rec(rel) {
    let ents; try { ents = fs.readdirSync(path.join(jobDir, rel), { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.name === '.git') && !repos.some(r => rel.startsWith(r + '/'))) repos.push(rel); // nested = vendored/untracked
    for (const e of ents) {
      const r = rel + '/' + e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(r); }
      else if (e.isFile()) {
        try { if (fs.statSync(path.join(jobDir, r)).size <= MAX_FILE) files.push(r); } catch {}
      }
    }
  })('input');
  return { files, repos };
}

// ---------- git ----------
// Commit shape: {author, day:'YYYY-MM-DD', hour, subject, files:[{path, added, removed}]}
function numstatLine(line) {
  const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
  if (!m) return null;
  // renames: "a => b" or "dir/{a => b}/c"
  const p = m[3].replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
  return { path: p, added: m[1] === '-' ? 0 : +m[1], removed: m[2] === '-' ? 0 : +m[2] };
}
function dayHour(s) {
  let m = s.match(/(\d{4}-\d\d-\d\d)[T ](\d\d)/);
  if (m) return { day: m[1], hour: +m[2] };
  m = s.match(/\w{3} (\w{3}) +(\d+) (\d\d):\d\d:\d\d (\d{4})/); // git default: Thu Oct 2 03:14:15 2026 +0530
  if (m && MONTHS[m[1]]) return { day: `${m[4]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`, hour: +m[3] };
  return null;
}
function gitLog(repoAbs) {
  const out = execFileSync('git', [
    '-c', 'log.showSignature=false', '-c', 'core.fsmonitor=false',
    'log', '--numstat', '--no-textconv', '--no-ext-diff', '--date=iso-strict', '--decorate=short',
    '--pretty=format:%x1e%an%x1f%ad%x1f%s%x1f%D',
  ], {
    cwd: repoAbs, timeout: 60000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).toString('utf8');
  const commits = [];
  for (const chunk of out.split('\x1e').slice(1)) {
    const [head, ...rest] = chunk.split('\n');
    const [author, date, subject, refs] = head.split('\x1f');
    const dh = dayHour(date || '');
    if (!dh) continue;
    commits.push({ author, ...dh, subject: subject || '', tag: /\btag: /.test(refs || ''), files: rest.map(numstatLine).filter(Boolean) });
  }
  return commits;
}
// Gitignored files and dirs (dirs end in '/'), e.g. node_modules/, dist/, a jobs/ folder of nested clones. Runs no hooks.
function gitIgnored(repoAbs) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], {
    cwd: repoAbs, timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).toString('utf8').split('\0').filter(Boolean);
}
// Pasted `git log --numstat` (default pretty format).
function parsePastedGitLog(text) {
  const commits = [];
  for (const chunk of text.split(/^commit [0-9a-f]{7,40}.*$/m).slice(1)) {
    const author = (chunk.match(/^Author:\s*(.*?)\s*(<.*)?$/m) || [])[1];
    const dh = dayHour((chunk.match(/^Date:\s*(.*)$/m) || [])[1] || '');
    if (!dh) continue;
    const subject = ((chunk.match(/^ {4}(.*\S.*)$/m) || [])[1] || '').trim();
    commits.push({ author: author || 'unknown', ...dh, subject, files: chunk.split('\n').map(numstatLine).filter(Boolean) });
  }
  return commits;
}
function commitType(s) {
  const m = s.match(/^(\w+)(\([^)]*\))?!?:/);
  const map = { feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', hotfix: 'fix', docs: 'docs', doc: 'docs',
    refactor: 'refactor', perf: 'refactor', style: 'refactor', test: 'test', tests: 'test',
    chore: 'chore', build: 'chore', ci: 'chore', revert: 'chore' };
  if (m && map[m[1].toLowerCase()]) return map[m[1].toLowerCase()];
  if (/\b(fix|fixe[sd]|bug|patch|resolve[sd]?|crash)\b/i.test(s)) return 'fix';
  if (/\b(docs?|readme|documentation|comment)\b/i.test(s)) return 'docs';
  if (/\b(tests?|spec)\b/i.test(s)) return 'test';
  if (/\b(refactor|clean ?up|rename|simplif|restructure|move)\w*/i.test(s)) return 'refactor';
  if (/\b(merge|bump|deps?|dependenc|chore|release|version|ci)\w*/i.test(s)) return 'chore';
  if (/\b(add|feat|implement|create|new|introduce|support|initial)\w*/i.test(s)) return 'feat';
  return 'other';
}
// First commit + tagged commits, then the biggest feat/add commits, one per time window across the span.
function milestones(commits) {
  const size = c => c.files.reduce((n, f) => n + f.added + f.removed, 0);
  const tags = commits.filter(c => c.tag && c !== commits[0]), k = Math.min(tags.length, MAX_MILESTONES - 1);
  const pick = new Set([commits[0], ...Array.from({ length: k }, (_, i) => tags[k < 2 ? 0 : Math.round(i * (tags.length - 1) / (k - 1))])]);
  const feats = commits.filter(c => !pick.has(c) && commitType(c.subject) === 'feat').sort((a, b) => size(b) - size(a));
  const t = c => Date.parse(c.day), t0 = t(commits[0]), span = t(commits[commits.length - 1]) - t0 + 1;
  const slots = MAX_MILESTONES - pick.size;
  for (let w = 0; w < slots; w++) { // biggest feat in each window, then fill empty windows with the next biggest
    const c = feats.find(c => !pick.has(c) && Math.min(slots - 1, Math.floor((t(c) - t0) / span * slots)) === w);
    if (c) pick.add(c);
  }
  for (const c of feats) if (pick.size < MAX_MILESTONES) pick.add(c);
  return commits.filter(c => pick.has(c)).map(c => ({ date: c.day, message: c.subject }));
}
function gitOutputs(allCommits, dataDir, charts) {
  // Drop vendored/generated paths from line/file stats, and drop commits that only touched those (lockfile
  // bumps, vendored drops). A commit to the repo's own .claude/skills is still real work, so it stays.
  const commits = allCommits
    .map(c => ({ ...c, files: c.files.filter(f => !vendored(f.path)), own: !c.files.length || c.files.some(f => !vendored(f.path) || f.path.startsWith('.claude/skills/')) }))
    .filter(c => c.own)
    .reverse() // git lists newest first
    .sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour);
  if (!commits.length) return null;
  const days = {}, hours = Array(24).fill(0), files = {}, types = {}, byAuthor = {};
  let added = 0, removed = 0;
  for (const c of commits) {
    const d = days[c.day] || (days[c.day] = [0, 0, 0]);
    d[0]++; hours[c.hour]++;
    byAuthor[c.author] = (byAuthor[c.author] || 0) + 1;
    types[commitType(c.subject)] = (types[commitType(c.subject)] || 0) + 1;
    for (const f of c.files) {
      d[1] += f.added; d[2] += f.removed; added += f.added; removed += f.removed;
      files[f.path] = (files[f.path] || 0) + 1;
    }
  }
  const sorted = Object.keys(days).sort();
  // Fill empty days with zeros so the line chart has a real time axis (skip for very long spans).
  const all = [];
  const first = new Date(sorted[0] + 'T00:00:00Z'), last = new Date(sorted[sorted.length - 1] + 'T00:00:00Z');
  if ((last - first) / 864e5 <= 366) for (let t = first; t <= last; t = new Date(+t + 864e5)) all.push(t.toISOString().slice(0, 10));
  else all.push(...sorted);
  // Only commits_per_day is charted (as the timeline backdrop); the rest are written for reference, not listed in facts.charts.
  if (writeCsv(dataDir, 'commits_per_day.csv', ['date', 'commits', 'added', 'removed'], all.map(d => [d, ...(days[d] || [0, 0, 0])])) >= 2)
    charts.push({ csv: 'data/commits_per_day.csv', kind: 'line', x: 'date', y: 'commits', title: 'Commits per day (timeline backdrop only)' });
  writeCsv(dataDir, 'commit_hours.csv', ['hour', 'commits'], hours.map((n, h) => [h, n]));
  writeCsv(dataDir, 'top_files.csv', ['file', 'changes'], Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 10));
  const order = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'other'];
  writeCsv(dataDir, 'commit_types.csv', ['type', 'count'], order.filter(t => types[t]).map(t => [t, types[t]]));
  const authors = Object.keys(byAuthor);
  return {
    commits: commits.length, authors: commits.length < 5 ? authors : authors.filter(a => byAuthor[a] >= 2),
    firstDate: sorted[0], lastDate: sorted[sorted.length - 1],
    activeDays: sorted.length, days: Math.round((Date.parse(sorted[sorted.length - 1]) - Date.parse(sorted[0])) / 864e5) + 1,
    milestones: milestones(commits),
    appendix: { linesAdded: added, linesRemoved: removed },
  };
}

// ---------- logs ----------
const TS = [
  [/(\d{4}-\d\d-\d\d)[T ](\d\d):\d\d/, m => ({ day: m[1], hour: m[2] })],
  [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d\d):\d\d:\d\d/, m => ({ day: `${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`, hour: m[3] })],
  [/\[(\d\d):\d\d:\d\d(?:\.\d+)?\]/, m => ({ day: null, hour: m[1] })],
];
const ERR = /\b(error|err!?|fatal|critical|panic|exception)\b|traceback/i;
const WARN = /\bwarn(ing)?\b/i;
function lineTs(line) {
  for (const [re, f] of TS) { const m = line.match(re); if (m) return f(m); }
  return null;
}
function looksLikeLog(text) {
  const lines = text.split('\n').filter(l => l.trim()).slice(0, 500);
  const hits = lines.filter(l => lineTs(l) || /\b(ERROR|WARN(ING)?|INFO|DEBUG)\b/.test(l)).length;
  return hits >= 3 && hits >= lines.length * 0.2;
}
function normalizeError(line) {
  return line
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.,]+(Z|[+-]\d\d:?\d\d)?/g, '')
    .replace(/\b[A-Z][a-z]{2} +\d{1,2} [\d:]{8}/g, '').replace(/\[[\d:.]+\]/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/(?:[A-Za-z]:)?(?:[\w.-]*\/)+[\w.-]+/g, '<path>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/^[\s:,\-\]|]+/, '').replace(/^\[?(ERROR|ERR|FATAL|CRIT(ICAL)?)\]?:?\s+/i, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function logOutputs(texts, dataDir, charts) {
  const stats = { lines: 0, errors: 0, warnings: 0 }, events = [], patterns = {};
  for (const text of texts) {
    let cur = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      stats.lines++;
      cur = lineTs(line) || cur; // continuation lines inherit the last timestamp
      const lvl = ERR.test(line) ? 'e' : WARN.test(line) ? 'w' : null;
      if (lvl === 'e') { stats.errors++; const p = normalizeError(line); if (p) patterns[p] = (patterns[p] || 0) + 1; }
      if (lvl === 'w') stats.warnings++;
      if (cur) events.push({ ...cur, lvl });
    }
  }
  // Bucket by day if that gives >=2 buckets, else by hour.
  const days = new Set(events.map(e => e.day).filter(Boolean));
  const key = days.size >= 2 ? e => e.day || `${e.hour}:00` : e => (e.day ? e.day + ' ' : '') + e.hour + ':00';
  const buckets = {};
  for (const e of events) {
    const b = buckets[key(e)] || (buckets[key(e)] = [0, 0]);
    if (e.lvl === 'e') b[0]++; if (e.lvl === 'w') b[1]++;
  }
  const rows = Object.keys(buckets).sort().map(k => [k, ...buckets[k]]);
  if (writeCsv(dataDir, 'errors_over_time.csv', ['bucket', 'errors', 'warnings'], rows) >= 2)
    charts.push({ csv: 'data/errors_over_time.csv', kind: 'line', x: 'bucket', y: 'errors', title: 'Errors over time' });
  const top = Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (writeCsv(dataDir, 'top_errors.csv', ['error', 'count'], top) >= 2)
    charts.push({ csv: 'data/top_errors.csv', kind: 'bar', x: 'error', y: 'count', title: 'Most frequent errors' });
  return stats;
}

// ---------- user tables ----------
const isNum = v => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim());
const isDate = v => /^\d{4}[-/]\d\d[-/]\d\d([T ][\d:.]+Z?([+-]\d\d:?\d\d)?)?$/.test(v.trim());
function tableOutput(rel, header, rows, dataDir, charts, used) {
  if (!header.length || rows.length < 1) return;
  let name = 'table_' + slug(path.basename(rel)), i = 2;
  while (used.has(name)) name = 'table_' + slug(path.basename(rel)) + '_' + i++;
  used.add(name);
  rows = rows.slice(0, 5000);
  const n = writeCsv(dataDir, name + '.csv', header, rows);
  const types = header.map((_, c) => {
    const vals = rows.map(r => (r[c] ?? '').toString()).filter(v => v.trim());
    if (!vals.length) return 'empty';
    return vals.every(isNum) ? 'number' : vals.every(isDate) ? 'date' : 'category';
  });
  const col = t => header[types.indexOf(t)];
  const num = col('number'), date = col('date'), cat = col('category');
  let chart = null;
  if (date && num) chart = { kind: 'line', x: date, y: num };
  else if (cat && num) {
    const ci = header.indexOf(cat), ni = header.indexOf(num);
    const cats = new Set(rows.map(r => r[ci]));
    const pie = cats.size === rows.length && rows.length <= 6 && rows.every(r => +r[ni] >= 0);
    chart = { kind: pie ? 'pie' : 'bar', x: cat, y: num };
  } else if (num && types.filter(t => t === 'number').length === 1) chart = { kind: 'hist', x: num, y: num };
  if (!chart || n < 2) return;
  const title = chart.kind === 'line' ? `${chart.y} over time` : chart.kind === 'hist' ? `Distribution of ${chart.y}` : `${chart.y} by ${chart.x}`;
  charts.push({ csv: `data/${name}.csv`, ...chart, title: title[0].toUpperCase() + title.slice(1) + ` (${path.basename(rel)})` });
}

// ---------- code ----------
// Likely entry points, in order: files a manifest names (main/bin/scripts, pyproject), entry-like names
// (shallowest first), then the largest non-test files. files[] is sorted entry first, then by size, tests last.
function codeFacts(code, files, abs) {
  const byPath = new Map(code.map(c => [c.path, c])), entry = [];
  const add = p => { if (byPath.has(p) && !entry.includes(p) && entry.length < MAX_ENTRY) entry.push(p); };
  for (const m of files.filter(f => /(^|\/)(package\.json|pyproject\.toml|setup\.py|Cargo\.toml)$/.test(f) && !vendored(f)).sort((a, b) => a.split('/').length - b.split('/').length)) {
    const dir = path.dirname(m), t = readText(abs(m)) || '';
    let refs = t.match(/[\w./-]+\.(m?[jt]sx?|cjs|py|rs|go|rb)\b/g) || [];
    if (m.endsWith('.toml')) refs = refs.concat((t.match(/=\s*"([\w.]+):\w+"/g) || []).map(s => s.match(/"([\w.]+):/)[1].replace(/\./g, '/') + '.py'));
    for (const r of refs) { add(path.join(dir, r)); add(path.join(dir, 'src', r)); }
  }
  const depth = p => p.split('/').length, big = (a, b) => b.lines - a.lines || a.path.localeCompare(b.path);
  const nonTest = code.filter(c => !TEST_FILE.test(c.path));
  nonTest.filter(c => ENTRY_NAME.test(path.basename(c.path, path.extname(c.path))))
    .sort((a, b) => depth(a.path) - depth(b.path) || big(a, b)).forEach(c => add(c.path));
  [...nonTest].sort(big).forEach(c => add(c.path));
  const rank = c => entry.includes(c.path) ? entry.indexOf(c.path) : TEST_FILE.test(c.path) ? 2e9 - c.lines : 1e9 - c.lines;
  return { files: [...code].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)).slice(0, MAX_CODE_FILES), entry };
}

// ---------- main ----------
function collect(jobDir) {
  jobDir = path.resolve(jobDir);
  const dataDir = path.join(jobDir, 'data'), imgDir = path.join(jobDir, 'images');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });
  const facts = { project: { name: '', readme: null }, repo: null, logs: null, code: null, charts: [], notes: [], answers: null, images: [] };
  const safe = (label, fn) => { try { return fn(); } catch (e) { console.error(`collect: ${label}: ${e.message}`); } };

  const walked = walk(jobDir), repos = walked.repos;
  // Inside a repo drop gitignored files (nested clones, build output, node_modules): they aren't the project.
  const ignored = repos.flatMap(r => (safe('ls-files ' + r, () => gitIgnored(path.join(jobDir, r))) || []).map(p => r + '/' + p));
  const files = walked.files.filter(f => !ignored.some(p => p.endsWith('/') ? f.startsWith(p) : f === p));
  const inRepo = f => repos.some(r => f.startsWith(r + '/'));
  const abs = f => path.join(jobDir, f);
  const commits = [], logTexts = [], usedTables = new Set();
  let notesTotal = 0;
  const addNote = (file, text) => {
    if (notesTotal >= NOTES_TOTAL) return;
    text = text.slice(0, Math.min(NOTE_MAX, NOTES_TOTAL - notesTotal));
    notesTotal += text.length;
    facts.notes.push({ file, text });
  };

  for (const r of repos) safe('git ' + r, () => commits.push(...gitLog(abs(r))));

  // Project name + README: first repo, else the folder all uploads share (e.g. input/<zip>/<project>).
  let root = repos[0];
  if (!root) {
    const dirs = files.filter(f => f.startsWith('input/') && f !== 'input/answers.md').map(f => path.dirname(f));
    root = dirs[0] || 'input';
    for (const d of dirs) while (root !== 'input' && d !== root && !d.startsWith(root + '/')) root = path.dirname(root);
  }
  safe('project', () => {
    const readme = files.find(f => path.dirname(f) === root && /^readme(\.md|\.txt)?$/i.test(path.basename(f)));
    const readmeText = readme && readText(abs(readme));
    if (readmeText) facts.project.readme = readmeText.slice(0, 4000);
    let pkgName = null;
    const pkg = files.find(f => f === root + '/package.json');
    if (pkg) { const t = readText(abs(pkg)); try { pkgName = JSON.parse(t).name; } catch {} if (t) addNote(pkg, t); }
    let remote = null;
    try { remote = (fs.readFileSync(abs(root + '/.git/config'), 'utf8').match(/url\s*=\s*\S*?([^/:\s]+?)(\.git)?\s*$/m) || [])[1]; } catch {}
    const h1 = readmeText && (readmeText.match(/^#\s+(.+)$/m) || [])[1];
    const folder = path.basename(root);
    facts.project.name = pkgName || remote || (h1 && h1.trim()) || (['repo', 'input'].includes(folder) ? '' : folder);
  });

  // Languages: files inside repos, or all input if there is no repo.
  safe('languages', () => {
    const langs = {}, code = [];
    for (const f of files) {
      if (repos.length && !inRepo(f)) continue;
      const lang = LANGS[path.extname(f).toLowerCase()];
      if (!lang || vendored(f)) continue;
      const t = readText(abs(f));
      if (!t) continue;
      const lines = t.split('\n').filter(l => l.trim()).length;
      langs[lang] = (langs[lang] || 0) + lines;
      if (!NOT_CODE.has(lang)) code.push({ path: f, lang, lines });
    }
    writeCsv(dataDir, 'languages.csv', ['language', 'lines'], Object.entries(langs).sort((a, b) => b[1] - a[1])); // not charted
    if (code.length) facts.code = codeFacts(code, files, abs);
  });

  for (const f of files) safe(f, () => {
    const ext = path.extname(f).toLowerCase();
    if (IMG_EXT.has(ext)) {
      if (facts.images.length >= MAX_IMAGES || vendored(f)) return;
      const id = 'img' + (facts.images.length + 1);
      // tectonic renders 16-bit PNGs blank with no error; re-encode those to 8-bit JPEG (sips = macOS only)
      const is16 = ext === '.png' && fs.readFileSync(abs(f)).subarray(24, 25)[0] === 16;
      let out = `images/${id}${ext}`;
      if (is16) try { execFileSync('sips', ['-s', 'format', 'jpeg', abs(f), '--out', abs(`images/${id}.jpg`)], { stdio: 'ignore' }); out = `images/${id}.jpg`; } catch {}
      if (out.endsWith(ext)) fs.copyFileSync(abs(f), abs(out));
      facts.images.push({ id, file: out, original: f });
      return;
    }
    if (inRepo(f)) return; // repo content is covered by git/languages/README
    if (f === 'input/answers.md') { facts.answers = readText(abs(f)); return; }
    if (!['.log', '.txt', '.md', '.csv', '.json'].includes(ext)) return;
    const text = readText(abs(f));
    if (text == null) return;
    if (ext === '.csv') { const [h, ...rows] = parseCsv(text); return tableOutput(f, h || [], rows, dataDir, facts.charts, usedTables); }
    if (ext === '.json') {
      const j = JSON.parse(text);
      if (!Array.isArray(j) || !j.length || typeof j[0] !== 'object' || !j[0]) return;
      const h = Object.keys(j[0]).filter(k => j[0][k] === null || typeof j[0][k] !== 'object');
      return tableOutput(f, h, j.map(o => h.map(k => (o && o[k] != null ? String(o[k]) : ''))), dataDir, facts.charts, usedTables);
    }
    if (ext !== '.log' && /^commit [0-9a-f]{7,40}/m.test(text)) {
      const c = parsePastedGitLog(text);
      if (c.length) return void commits.push(...c);
    }
    if (ext === '.log' || (ext === '.txt' && looksLikeLog(text))) return void logTexts.push(text);
    addNote(f, text);
  });

  if (commits.length) safe('git outputs', () => { facts.repo = gitOutputs(commits, dataDir, facts.charts); });
  if (logTexts.length) safe('logs', () => { facts.logs = logOutputs(logTexts, dataDir, facts.charts); });

  fs.writeFileSync(path.join(jobDir, 'facts.json'), JSON.stringify(facts, null, 2));
  return facts;
}

module.exports = { collect };

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('usage: node collect.js <jobDir>');
    const f = collect(process.argv[2]);
    console.log(`collect: ${f.repo ? f.repo.commits : 0} commits, ${f.charts.length} charts, ${f.notes.length} notes, ${f.images.length} images`);
  } catch (e) { console.error('collect failed:', e.message); }
  process.exit(0);
}
