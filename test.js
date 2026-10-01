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
  assert.deepStrictEqual(facts.repo, { commits: 3, authors: ['Ada'], firstDate: '2026-09-28', lastDate: '2026-09-30', linesAdded: 7, linesRemoved: 1, activeDays: 2, days: 3 });
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
  assert.ok(facts.charts.some(c => c.csv === 'data/commits_per_day.csv' && c.kind === 'line'));

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
  assert.strictEqual(facts.repo.linesAdded, 13);
  assert.deepStrictEqual(csv(job, 'commit_types.csv'), ['type,count', 'fix,1', 'test,1']);
  assert.deepStrictEqual(facts.logs, { lines: 5, errors: 2, warnings: 1 });
  assert.strictEqual(facts.notes.length, 0);
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
