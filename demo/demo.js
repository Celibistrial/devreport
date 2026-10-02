// devreport static demo: fakes the /api/ surface (XHR, EventSource, fetch) so the real UI plays a prebuilt build.
// Loaded before the main script by demo/build.sh. Nothing leaves the browser.
(() => {
  const ID = 'dec0de01', YT = 'https://www.youtube.com/watch?v=0RqY4tLsTRk', REPO = 'https://github.com/Celibistrial/devreport';
  const job = { kind: 'slides', theme: 'paper', version: 1, template: false, script: [] };
  const compiled = new Set();
  const pdfFor = (j) => j.kind === 'report' ? '/assets/report.pdf' : `/assets/slides/${j.theme}.pdf`;
  const done = () => ({ pdf: pdfFor(job), tex: job.kind === 'report' ? '/assets/report.tex' : '/assets/slides/main.tex', kind: job.kind, version: job.version, theme: job.theme, template: job.template });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // a first build: [ms before this step, icon, text]
  function buildScript(fd) {
    const files = fd.getAll('files[]'), repo = (fd.get('repoUrl') || '').replace('https://github.com/', '');
    const kind = fd.get('kind'), theme = fd.get('theme'), len = fd.get('length'), unit = kind === 'slides' ? 'slides' : 'pages';
    const s = [];
    if (files.length) s.push([400, 'upload', `Received ${plural(files.length, 'file')}`]);
    const zip = files.find((f) => /\.zip$/i.test(f.name));
    if (zip) s.push([700, 'zip', `Unpacking ${zip.name}`], [900, 'zip', `Unpacked into ${zip.name.replace(/\.zip$/i, '')}/`]);
    if (repo) s.push([500, 'clone', `Cloning ${repo}`], [1800, 'clone', 'Repository cloned']);
    s.push([1200, 'collect', 'Found 214 commits, 6 charts worth of data']);
    if (theme === 'custom') s.push([600, 'template', `Reading your template ${fd.get('template')?.name || 'template.pptx'}`], [900, 'template', 'Template: 6 colours, Calibri and Georgia, 3 images']);
    s.push(
      [700, 'think', `Handing off to the agent (${kind}, ${theme} theme, about ${len} ${unit})`],
      [1300, 'think', 'Agent started'],
      [600, 'skill', 'Loading the devreport playbook'],
      [500, 'skill', 'Reading the playbook (SKILL.md)'],
      [600, 'doc', 'Reading job.json'],
      [500, 'data', 'Reading facts.json'],
      [500, 'data', 'Reading data/commits_by_week.csv'],
      [600, 'code', 'Reading code: repo/server.js'],
      [500, 'doc', 'Reading repo/README.md'],
      [600, 'image', 'Looking at repo/docs/gallery-01.png'],
      [500, 'note', 'The commit history has a clear arc: a spike when the agent loop landed, then steady polish.'],
      [900, 'plan', 'Planning the outline'],
      [1800, 'write', 'Writing main.tex'],
      [1500, 'compile', 'Compiling with tectonic'],
      [2200, 'error', 'Compile error, fixing'],
      [700, 'tex', 'Reading main.log'],
      [900, 'edit', 'Editing main.tex'],
      [900, 'compile', 'Compiling with tectonic'],
      [1800, 'humanize', 'Humanizing the prose'],
      [1400, 'edit', 'Editing main.tex'],
      [900, 'compile', 'Compiling with tectonic'],
      [1600, 'review', 'Checking the rendered main.pdf'],
      [1500, 'final', `Built a ${len}-${unit.slice(0, -1)} ${kind === 'slides' ? 'deck' : 'report'} from the repo: every chart is drawn from facts.json, nothing estimated. Compiled clean on the second try.`],
      [500, 'done'],
    );
    return s;
  }
  function reviseScript(fd) {
    const what = job.kind === 'slides' ? 'deck' : 'report', pages = JSON.parse(fd.get('pages') || '[]');
    const k = fd.getAll('files').length, added = k || fd.get('notes') || fd.get('repoUrl');
    const asked = [fd.get('general') && `notes on the whole ${what}`, pages.length && `notes on page${pages.length === 1 ? '' : 's'} ${pages.map((p) => p.page).join(', ')}`, added && 'new material'].filter(Boolean).join(' and ');
    const n = job.version - 1, s = [[300, 'revise', `Revision ${n}: ${asked}. Saved v${n} as a backup`]];
    if (added) s.push([600, 'upload', 'Received ' + [k && plural(k, 'file'), fd.get('notes') && 'a note', fd.get('repoUrl') && 'a GitHub link'].filter(Boolean).join(' and ')],
      [900, 'collect', 'Re-counted: nothing new to chart, the agent will read the new files']);
    s.push([900, 'think', 'Agent picked up where it left off'], [800, 'tex', 'Reading main.tex'], [1400, 'edit', 'Editing main.tex'],
      [900, 'compile', 'Compiling with tectonic'], [1600, 'review', 'Checking the rendered main.pdf'],
      [1200, 'final', `Applied the notes and recompiled. v${n} is kept as a backup.`], [400, 'done']);
    return s;
  }

  // EventSource: replays job.script, one timer per step
  // replay pace 0.32: a first build lands in about 10 s
  window.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 1; this.l = {}; this.timers = []; let at = 0;
      for (const [ms, icon, text] of job.script) { at += ms * 0.32; this.timers.push(setTimeout(() => icon === 'done'
        ? (job.script = [[0, 'done']], this.emit('done', { ...done(), t: Date.now() })) // a reattach replays just the result
        : this.emit('step', { icon, text, t: Date.now() }), at)); }
    }
    emit(type, d) { (this.l[type] || []).forEach((f) => f({ data: JSON.stringify(d) })); }
    addEventListener(type, f) { (this.l[type] ||= []).push(f); }
    close() { this.readyState = 2; this.timers.forEach(clearTimeout); }
    static CLOSED = 2;
  };

  // XHR: only /api/ is faked (job create, revise); the rest goes to the network
  window.XMLHttpRequest = class extends XMLHttpRequest {
    open(m, u, ...r) { this.api = /^\/api\//.test(u) && u; if (!this.api) super.open(m, u, ...r); }
    send(fd) {
      if (!this.api) return super.send(fd);
      const reply = (status, body) => { Object.defineProperty(this, 'status', { value: status }); Object.defineProperty(this, 'responseText', { value: JSON.stringify(body) }); this.onload?.(); };
      let p = 0; const up = setInterval(() => { p = Math.min(100, p + 20); this.upload.onprogress?.({ lengthComputable: true, loaded: p, total: 100 }); if (p < 100) return;
        clearInterval(up);
        if (this.api === '/api/jobs') {
          Object.assign(job, { kind: fd.get('kind'), theme: fd.get('theme'), version: 1, template: fd.get('theme') === 'custom' }); compiled.clear(); compiled.add(job.theme);
          job.script = buildScript(fd); reply(201, { id: ID });
        } else { job.version++; job.script = reviseScript(fd); reply(200, { version: job.version }); }
      }, 120);
    }
  };

  // fetch: theme switch and answers
  const realFetch = window.fetch.bind(window);
  window.fetch = async (u, o = {}) => {
    if (typeof u !== 'string' || !u.startsWith('/api/')) return realFetch(u, o);
    const json = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/theme')) {
      const { theme } = JSON.parse(o.body), cached = compiled.has(theme), ms = cached ? 0 : 1100 + Math.random() * 400 | 0;
      await new Promise((r) => setTimeout(r, cached ? 150 : ms));
      compiled.add(theme); job.theme = theme;
      return json({ theme, pdf: `${pdfFor(job)}?v=${job.version}`, ms, cached });
    }
    return json({ ok: true });
  };

  // a reload starts over (no server to reattach to); version links all open the current PDF
  if (/^#job=/.test(location.hash)) history.replaceState(null, '', location.pathname);
  document.addEventListener('click', (e) => { const a = e.target.closest?.('#hist a'); if (a) a.href = pdfFor(job); }, true);

  document.addEventListener('DOMContentLoaded', () => {
    const repo = document.querySelector('#repo'); repo.value = 'Celibistrial/devreport';
    document.querySelector('#again').addEventListener('click', () => setTimeout(() => { repo.value ||= 'Celibistrial/devreport'; })); // "New deck" clears it
    document.querySelector('.logo .tag').textContent = 'v0.1 · demo';
    document.querySelector('footer span').textContent = 'Static demo: the build replays a prebuilt run. Run it locally to typeset your own repo.';
    const link = (href, t) => `<a href="${href}" target="_blank" rel="noopener">${t}</a>`, tag = '<span class="demotag">demo replay</span>';
    document.body.insertAdjacentHTML('afterbegin', `<div class="demobar" role="note"><div class="wrap"><b>Demo</b><span>This is a demo. Nothing runs here: the build is a replay and the PDFs were made earlier by devreport. To run it on your own project, clone the repo.</span><span class="dl">${link(YT, 'Watch the video')}${link(REPO, 'Clone on GitHub')}</span></div></div>`);
    document.querySelector('#pill').insertAdjacentHTML('beforebegin', tag);
    document.querySelector('#donemsg').insertAdjacentHTML('afterend', tag);
    document.querySelector('#feed').insertAdjacentHTML('beforebegin', '<p class="demofeed">Demo replay of a recorded build. No agent or LaTeX is running.</p>');
    // files are never sent: the fake XHR only reads their names for the replay text
    document.querySelectorAll('.drop p').forEach((p) => p.insertAdjacentHTML('beforeend', '<br><span class="demonote">Demo: nothing is uploaded. Files stay in your browser; only their names are used.</span>'));
    document.head.insertAdjacentHTML('beforeend', `<style>
      .demobar{background:var(--ink);color:var(--paper);font:13px/1.45 var(--sans)}
      .demobar .wrap{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 14px;padding-top:9px;padding-bottom:9px}
      .demobar b{font:500 11px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;background:var(--accent);color:#fff;border-radius:4px;padding:4px 7px}
      .demobar span{flex:1 1 300px;min-width:0}
      .demobar .dl{flex:0 0 auto;display:flex;gap:14px;font:500 11px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase}
      .demobar a{color:var(--paper);text-decoration:none;border-bottom:1px solid var(--accent)}
      .demobar a:hover{color:var(--accent)}
      .demotag{display:inline-block;font:500 10px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent-ink);border:1px solid currentColor;border-radius:99px;padding:4px 8px;margin-right:8px;white-space:nowrap;vertical-align:middle}
      .dbar .demotag{margin:0 0 0 8px}
      .demofeed{margin:0;padding:12px 18px 10px;border-bottom:1px solid var(--rule2);font:12px/1.5 var(--mono);color:var(--muted)}
      .demonote{color:var(--accent-ink);font-size:12px}
    </style>`);
  });
})();
