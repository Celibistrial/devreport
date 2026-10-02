const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { collect } = require('./collect');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function makeJob() {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-test-'));
  const input = path.join(job, 'input'), repo = path.join(input, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args, date) => execFileSync('git', args, {
    cwd: repo, stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'a@x', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  git(['init', '-q']);
  const commit = (file, body, msg, date) => {
    fs.writeFileSync(path.join(repo, file), body);
    git(['add', '-A']); git(['commit', '-q', '-m', msg], date);
  };
  commit('README.md', '# Widget\n\nA widget.\n', 'docs: add readme', '2026-09-28T10:00:00+00:00');
  commit('app.js', 'let a = 1;\nlet b = 2;\n', 'feat: app skeleton', '2026-09-28T14:00:00+00:00');
  commit('app.js', 'let a = 1;\nlet b = 3;\nlet c = 4;\n', 'fix crash on start', '2026-09-30T14:30:00+00:00');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"widget-app"}');

  fs.writeFileSync(path.join(input, 'server.log'), [
    '2026-09-28T10:00:01Z INFO boot',
    '2026-09-28T10:05:00Z ERROR db timeout after 3000ms id=7f3a9c21ee',
    '2026-09-28T10:06:00Z ERROR db timeout after 4100ms id=1b2c3d4e5f',
    '2026-09-29T11:00:00Z WARN slow query',
    '2026-09-29T11:01:00Z ERROR file /var/app/x.json not found',
  ].join('\n'));
  fs.writeFileSync(path.join(input, 'sales.csv'), 'month,revenue\n2026-07-01,100\n2026-08-01,"1200"\n2026-09-01,900\n');
  fs.writeFileSync(path.join(input, 'notes.md'), '# Notes\nTried websockets, too flaky.\n');
  fs.writeFileSync(path.join(input, 'answers.md'), 'For students.');
  fs.writeFileSync(path.join(input, 'shot.png'), PNG);
  fs.writeFileSync(path.join(input, 'junk.bin'), Buffer.from([0, 1, 2, 0, 255]));
  fs.writeFileSync(path.join(input, 'broken.json'), '{nope');
  return job;
}

const csv = (job, name) => fs.readFileSync(path.join(job, 'data', name), 'utf8').trim().split('\n');

test('collects git, logs, tables, notes, images', () => {
  const job = makeJob();
  const facts = collect(job);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(job, 'facts.json'))), facts);

  assert.strictEqual(facts.project.name, 'widget-app');
  assert.match(facts.project.readme, /A widget/);
  assert.deepStrictEqual(facts.repo, { commits: 3, authors: ['Ada'], firstDate: '2026-09-28', lastDate: '2026-09-30', activeDays: 2, days: 3,
    milestones: [{ date: '2026-09-28', message: 'docs: add readme' }, { date: '2026-09-28', message: 'feat: app skeleton' }],
    appendix: { linesAdded: 7, linesRemoved: 1 } });
  assert.deepStrictEqual(csv(job, 'commits_per_day.csv'), ['date,commits,added,removed', '2026-09-28,2,5,0', '2026-09-29,0,0,0', '2026-09-30,1,2,1']);
  const hours = csv(job, 'commit_hours.csv');
  assert.strictEqual(hours.length, 25);
  assert.strictEqual(hours[15], '14,2');
  assert.deepStrictEqual(csv(job, 'commit_types.csv'), ['type,count', 'feat,1', 'fix,1', 'docs,1']);
  assert.strictEqual(csv(job, 'top_files.csv')[1], 'app.js,2');
  assert.ok(csv(job, 'languages.csv').some(l => l.startsWith('JavaScript,')));

  assert.deepStrictEqual(facts.logs, { lines: 5, errors: 3, warnings: 1 });
  assert.deepStrictEqual(csv(job, 'errors_over_time.csv'), ['bucket,errors,warnings', '2026-09-28,2,0', '2026-09-29,1,1']);
  assert.strictEqual(csv(job, 'top_errors.csv')[1], 'db timeout after <n>ms id=<hex>,2');

  assert.deepStrictEqual(csv(job, 'table_sales.csv'), ['month,revenue', '2026-07-01,100', '2026-08-01,1200', '2026-09-01,900']);
  const sales = facts.charts.find(c => c.csv === 'data/table_sales.csv');
  assert.deepStrictEqual([sales.kind, sales.x, sales.y], ['line', 'month', 'revenue']);
  // git vanity charts are written as CSVs but not offered as charts
  assert.deepStrictEqual(facts.charts.map(c => c.csv).sort(),
    ['data/commits_per_day.csv', 'data/errors_over_time.csv', 'data/table_sales.csv', 'data/top_errors.csv']);

  assert.deepStrictEqual(facts.notes.map(n => n.file), ['input/repo/package.json', 'input/notes.md']);
  assert.strictEqual(facts.answers, 'For students.');
  assert.deepStrictEqual(facts.images, [{ id: 'img1', file: 'images/img1.png', original: 'input/shot.png' }]);
  assert.ok(fs.existsSync(path.join(job, 'images/img1.png')));
});

test('pasted git log text and syslog/[HH:MM:SS] logs', () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-test-'));
  fs.mkdirSync(path.join(job, 'input'));
  fs.writeFileSync(path.join(job, 'input/gitlog.txt'), [
    'commit 1111111111111111111111111111111111111111', 'Author: Bo <b@x>', 'Date:   Thu Oct 1 09:10:11 2026 +0530', '',
    '    fix: null deref', '', '3\t1\tsrc/a.c', '',
    'commit 2222222222222222222222222222222222222222', 'Author: Cy <c@x>', 'Date:   Fri Oct 2 23:00:00 2026 +0530', '',
    '    add tests', '', '10\t0\ttest/a_test.c', '-\t-\tlogo.png',
  ].join('\n'));
  fs.writeFileSync(path.join(job, 'input/build.txt'), '[10:00:01] start\n[10:00:02] warning: x\n[11:00:00] error: y\n[11:00:01] done\n');
  fs.writeFileSync(path.join(job, 'input/sys.log'), 'Oct  2 03:14:15 host app: ERROR fail\n');
  const facts = collect(job);
  assert.deepStrictEqual(facts.repo.authors, ['Bo', 'Cy']);
  assert.strictEqual(facts.repo.appendix.linesAdded, 13);
  assert.deepStrictEqual(facts.repo.milestones.map(m => m.message), ['fix: null deref']); // 'add tests' is a test commit, not a feature
  assert.deepStrictEqual(csv(job, 'commit_types.csv'), ['type,count', 'fix,1', 'test,1']);
  assert.deepStrictEqual(facts.logs, { lines: 5, errors: 2, warnings: 1 });
  assert.strictEqual(facts.notes.length, 0);
});

test('vendored paths, nested repos and drive-by authors stay out of the stats; milestones spread and tags', () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-test-'));
  const repo = path.join(job, 'input', 'app');
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd, args, date, who = 'Ada') => execFileSync('git', args, {
    cwd, stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: who,
      GIT_COMMITTER_EMAIL: 'a@x', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); };
  git(repo, ['init', '-q']);
  const commit = (files, msg, day, who) => { for (const [f, b] of Object.entries(files)) put(f, b); git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', msg], `${day}T12:00:00+00:00`, who); };
  commit({ 'a.js': 'x\n' }, 'initial commit', '2026-01-01');
  commit({ 'vendor/lib.js': 'v\n'.repeat(500), 'package-lock.json': '{}\n'.repeat(300) }, 'add vendored lib', '2026-01-02', 'Sindre');
  for (let i = 0; i < 12; i++) commit({ [`f${i}.js`]: 'y\n'.repeat(i + 1) }, `feat: part ${i}`, `2026-01-${String(3 + i * 2).padStart(2, '0')}`);
  git(repo, ['tag', 'v1'], '2026-01-30T00:00:00+00:00');
  commit({ 'b.js': 'z\n' }, 'fix typo', '2026-01-28', 'Drive-by');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'jobs/\n');
  // a nested clone inside a gitignored jobs/ folder is not part of the project
  const nested = path.join(repo, 'jobs', 'x', 'repo');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(repo, 'jobs', 'x', 'shot.png'), PNG);
  git(nested, ['init', '-q']); fs.writeFileSync(path.join(nested, 'n.js'), 'n\n');
  git(nested, ['add', '-A']); git(nested, ['commit', '-q', '-m', 'add nested'], '2011-01-26T00:00:00+00:00', 'Old');

  const facts = collect(job);
  const r = facts.repo;
  assert.strictEqual(r.firstDate, '2026-01-01');
  assert.strictEqual(r.commits, 14); // vendored-only commit dropped
  assert.deepStrictEqual(r.authors, ['Ada']); // Drive-by has 1 commit
  assert.strictEqual(r.appendix.linesAdded, 1 + 78 + 1);
  assert.ok(!csv(job, 'top_files.csv').some(l => /vendor|lock/.test(l)));
  assert.ok(!fs.readFileSync(path.join(job, 'data/languages.csv'), 'utf8').includes('JSON'));
  assert.deepStrictEqual(facts.images, []);
  assert.ok(r.milestones.length === 8);
  assert.deepStrictEqual(r.milestones[0], { date: '2026-01-01', message: 'initial commit' });
  assert.ok(r.milestones.some(m => m.message === 'feat: part 11')); // tagged (and biggest)
  const dates = r.milestones.map(m => m.date);
  assert.deepStrictEqual(dates, [...dates].sort());
  assert.ok(dates.some(d => d < '2026-01-10') && dates.some(d => d > '2026-01-20'), 'spread across the span');
});

test('code facts: source files without vendored/tests noise, entry points from manifests, names and size', () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-test-'));
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(job, rel)), { recursive: true }); fs.writeFileSync(path.join(job, rel), body); };
  const lines = n => 'x = 1\n'.repeat(n);
  put('input/p/server.py', lines(38)); put('input/p/client.py', lines(28)); put('input/p/util/helpers.py', lines(90));
  put('input/p/tests/test_server.py', lines(200)); put('input/p/dist/bundle.min.js', lines(999));
  put('input/p/requirements.txt', 'websockets\n'); put('input/p/notes.md', '# n\n');
  put('input/p/package.json', '{"name":"p","bin":{"p":"./tools/go.js"},"scripts":{"start":"node tools/go.js"}}'); put('input/p/tools/go.js', lines(3));
  const c = collect(job).code;
  assert.deepStrictEqual(c.entry, ['input/p/tools/go.js', 'input/p/server.py', 'input/p/client.py', 'input/p/util/helpers.py']);
  assert.deepStrictEqual(c.files.map(f => f.path), [...c.entry, 'input/p/tests/test_server.py']);
  assert.deepStrictEqual(c.files[1], { path: 'input/p/server.py', lang: 'Python', lines: 38 });
  assert.strictEqual(collect(fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-test-'))).code, null);
});

test('empty and missing input never throws', () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-test-'));
  const facts = collect(job);
  assert.deepStrictEqual(facts.charts, []);
  assert.strictEqual(facts.repo, null);
});

test('names an upload-only project after the folder the files share', () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-test-'));
  const dir = path.join(job, 'input', 'studybuddy', 'studybuddy');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), 'devlog');
  fs.writeFileSync(path.join(dir, 'shots', 'a.png'), PNG);
  fs.writeFileSync(path.join(job, 'input', 'answers.md'), 'For students.');
  assert.strictEqual(collect(job).project.name, 'studybuddy');
});

test('pptx.js extracts palette, fonts, layout boxes, media; rejects non-pptx and escaping entries', () => {
  const { extract } = require('./pptx');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-pptx-test-'));
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const ph = (type, x, y, w, h) => `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm></p:spPr></p:sp>`;
  const parts = {
    'ppt/presentation.xml': `<p:presentation ${A}><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/theme/theme1.xml': `<a:theme ${A}><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="fafafa"/></a:lt1><a:accent1><a:srgbClr val="0B5CAD"/></a:accent1><a:accent2><a:srgbClr val="F28C28"/></a:accent2></a:clrScheme>`
      + '<a:fontScheme name="x"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="No Such Font 123"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>',
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${A}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree>${ph('title', 457200, 274320, 8229600, 1143000)}${ph('body', 457200, 1600200, 8229600, 4525963)}</p:spTree></p:cSld></p:sldMaster>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${A} type="title"><p:cSld><p:spTree>${ph('ctrTitle', 914400, 2286000, 7315200, 1371600)}</p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/slideLayout2.xml': `<p:sldLayout ${A} type="obj"><p:cSld><p:spTree></p:spTree></p:cSld></p:sldLayout>`,
    'ppt/media/image1.png': PNG.toString('latin1'), 'ppt/media/image2.emf': 'x', 'docProps/thumbnail.jpeg': 'jpeg',
  };
  const zip = (file, entries) => execFileSync('python3', ['-c',
    'import sys,json,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor k,v in json.loads(sys.stdin.read()).items(): z.writestr(k, v.encode("latin1"))',
    file], { input: JSON.stringify(entries) });
  zip(path.join(dir, 'ok.pptx'), parts);
  const t = extract(path.join(dir, 'ok.pptx'), path.join(dir, 'out'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'template.json'))), t);
  assert.deepStrictEqual(t.colors, { dk1: '000000', lt1: 'FAFAFA', accent1: '0B5CAD', accent2: 'F28C28' });
  assert.deepStrictEqual(t.fonts.minor, { name: 'No Such Font 123', installed: false });
  assert.strictEqual(t.fonts.major.name, 'Georgia');
  assert.strictEqual(t.slide.aspect, 1.333);
  assert.deepStrictEqual(t.background, { color: 'FAFAFA' });
  assert.deepStrictEqual(t.layouts.title.title, { x: 0.1, y: 0.333, w: 0.8, h: 0.2 });
  assert.deepStrictEqual(t.layouts.content.body, { x: 0.05, y: 0.233, w: 0.9, h: 0.66 }); // inherited from the master
  assert.deepStrictEqual(t.media, [{ file: 'media/image1.png', width: 1, height: 1, usedBy: [] }]);
  assert.ok(fs.existsSync(path.join(dir, 'out', 'thumbnail.jpeg')));

  fs.writeFileSync(path.join(dir, 'notes.pptx'), 'not a zip');
  assert.throws(() => extract(path.join(dir, 'notes.pptx'), path.join(dir, 'o2')), /Not a \.pptx/);
  zip(path.join(dir, 'evil.pptx'), { ...parts, '../evil.txt': 'x' });
  assert.throws(() => extract(path.join(dir, 'evil.pptx'), path.join(dir, 'o3')), /escapes/);
});

test('parseRevision validates revise feedback', () => {
  const { parseRevision } = require('./server');
  const ok = parseRevision(JSON.stringify({ general: ' tighter ', pages: [{ page: 5, note: 'b' }, { page: 3, note: ' a ' }, { page: 9, note: '  ' }] }));
  assert.deepStrictEqual(ok, { general: 'tighter', pages: [{ page: 3, note: 'a' }, { page: 5, note: 'b' }] });
  for (const [body, re] of [['nope', /JSON/], ['[]', /object/], ['{}', /change/], ['{"general":5}', /string/],
    [JSON.stringify({ general: 'x'.repeat(4001) }), /over 4000/], ['{"pages":[{"page":2.5,"note":"x"}]}', /whole numbers/],
    ['{"pages":[{"page":"3","note":"x"}]}', /whole numbers/], ['{"pages":[{"page":0,"note":"x"}]}', /whole numbers/],
    ['{"pages":{}}', /array/], [JSON.stringify({ pages: [{ page: 1, note: 'x'.repeat(1001) }] }), /over 1000/]])
    assert.throws(() => parseRevision(body), re);
});
