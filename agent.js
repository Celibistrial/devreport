// devreport's own agent loop on the Vercel AI SDK: a drop-in for `claude -p ... --output-format stream-json`.
//   node agent.js [--resume <session>] -p "<prompt>"     (cwd = the job folder)
// The model gets four tools and nothing else: read_file, write_file, edit_file, compile, all confined to the job folder.
// DEVREPORT_MODEL=<provider>:<model> picks the model: claude-code:<sonnet|opus|...> (local Claude Code login, for
// testing) or openrouter:<model id> (OPENROUTER_API_KEY). Prints the stream-json lines server.js parses and keeps the
// conversation in agent-messages.json so a run that stopped to ask questions can be resumed.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const SKILL_DIR = path.join(__dirname, '.claude/skills/devreport');
const MESSAGES = 'agent-messages.json';
const MAX_STEPS = 80;
const COMPILE_TIMEOUT = 120000;
const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// server-owned files the agent may read but never write
const PROTECTED = /^(job\.json|theme\.tex|facts\.json|agent-messages\.json|(data|input|images|revisions|themes)(\/|$))/;

const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };

// The one path check. p (relative to jobDir, or absolute) must land inside jobDir, or inside the skill folder for reads.
// No symlinks anywhere below that root (the real path must equal the lexical one), and writes can't touch a
// server-owned file. Returns the absolute path.
function resolveInJob(jobDir, p, { write = false } = {}) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new Error('Give a file path');
  const abs = path.resolve(jobDir, p);
  const root = (write ? [jobDir] : [jobDir, SKILL_DIR]).find((r) => inside(r, abs));
  if (!root) throw new Error(`${p} is outside the job folder`);
  let probe = abs; // nearest part that exists (lstat, so a dangling symlink counts)
  while (!fs.lstatSync(probe, { throwIfNoEntry: false })) probe = path.dirname(probe);
  let real; try { real = fs.realpathSync(probe); } catch { throw new Error(`${p} is a broken symlink`); }
  if (real !== path.join(fs.realpathSync(root), path.relative(root, probe))) throw new Error(`${p} goes through a symlink`);
  if (write) {
    const rel = path.relative(jobDir, abs);
    if (!rel || PROTECTED.test(rel.split(path.sep).join('/'))) throw new Error(`${p} belongs to the server; don't write it`);
  }
  return abs;
}

// tool results in MCP shape: {content: [{type:'text', text} | {type:'image', data, mimeType}], isError?}
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) });
const tail = (s, n) => s.split('\n').slice(-n).join('\n').trim();

async function readFile({ path: p, offset, limit, pages }, jobDir) {
  const abs = resolveInJob(jobDir, p), st = await fsp.stat(abs), ext = path.extname(abs).toLowerCase();
  if (st.isDirectory()) {
    const list = (await fsp.readdir(abs, { withFileTypes: true })).map((e) => e.name + (e.isDirectory() ? '/' : ''));
    return text(list.slice(0, 500).join('\n') || '(empty folder)');
  }
  if (IMAGE[ext]) {
    let file = abs, mime = IMAGE[ext];
    if (st.size > 3.5e6) { // API image limit: shrink big screenshots (sips: macOS only, like collect.js)
      file = path.join(os.tmpdir(), `devreport-${process.pid}.jpg`); mime = 'image/jpeg';
      await run('sips', ['-Z', '1600', '-s', 'format', 'jpeg', abs, '--out', file]);
    }
    return { content: [{ type: 'image', data: (await fsp.readFile(file)).toString('base64'), mimeType: mime }] };
  }
  if (ext === '.pdf') { // pages rendered to PNG with poppler, at most 10 per call
    let total = 1;
    try { total = +/^Pages:\s+(\d+)/m.exec((await run('pdfinfo', [abs])).stdout)?.[1] || 1; }
    catch (e) { return text(e.code === 'ENOENT' ? 'PDF pages can\'t be shown here (poppler is not installed)' : `${p} is not a readable PDF`, true); }
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(pages || ''));
    const from = m ? +m[1] : 1, to = Math.min(m ? +(m[2] || m[1]) : total, from + 9, total);
    if (from > total) return text(`${p} has ${total} pages`, true);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devreport-pdf-'));
    try {
      await run('pdftoppm', ['-r', '60', '-png', '-f', String(from), '-l', String(to), abs, path.join(dir, 'p')], { timeout: 60000 });
      const files = (await fsp.readdir(dir)).sort();
      const imgs = await Promise.all(files.map(async (f) => ({ type: 'image', data: (await fsp.readFile(path.join(dir, f))).toString('base64'), mimeType: 'image/png' })));
      return { content: [{ type: 'text', text: `${p}: ${total} page${total === 1 ? '' : 's'}, showing ${from}-${to}` }, ...imgs] };
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  }
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return text(`${p} is a binary file`, true);
  const lines = buf.toString('utf8').split('\n'), start = Math.max(1, offset || 1), n = limit || 2000;
  const out = lines.slice(start - 1, start - 1 + n).map((l) => (l.length > 2000 ? l.slice(0, 2000) + ' [line cut]' : l)).join('\n');
  const more = start - 1 + n < lines.length ? `\n[showing lines ${start}-${start - 1 + n} of ${lines.length}; use offset to read on]` : '';
  return text(out + more);
}

async function writeFile({ path: p, content }, jobDir) {
  const abs = resolveInJob(jobDir, p, { write: true });
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  return text(`Wrote ${p}`);
}

async function editFile({ path: p, old_string, new_string, replace_all }, jobDir) {
  const abs = resolveInJob(jobDir, p, { write: true });
  const src = await fsp.readFile(abs, 'utf8'), n = old_string ? src.split(old_string).length - 1 : 0;
  if (!n) return text(`old_string not found in ${p}`, true);
  if (n > 1 && !replace_all) return text(`old_string occurs ${n} times in ${p}: add context to make it unique, or set replace_all`, true);
  await fsp.writeFile(abs, replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string));
  return text(`Edited ${p}`);
}

// `tectonic <file>` in the job folder and nothing else. file is one of two fixed names (the schema enforces it too)
const COMPILABLE = ['main.tex', 'template-test.tex'];
async function compile({ file = 'main.tex' }, jobDir) {
  if (!COMPILABLE.includes(file)) return text(`Only ${COMPILABLE.join(' or ')} can be compiled`, true);
  if (!fs.existsSync(path.join(jobDir, file))) return text(`There is no ${file} yet`, true);
  try {
    const { stdout, stderr } = await run('tectonic', [file], { cwd: jobDir, timeout: COMPILE_TIMEOUT, maxBuffer: 16 * 1024 * 1024 });
    const warn = `${stdout}\n${stderr}`.split('\n').filter((l) => /^warning|overfull|underfull/i.test(l)).slice(0, 15);
    return text(`Compiled ${file.replace(/\.tex$/, '.pdf')}.${warn.length ? '\n' + warn.join('\n') : ''}`);
  } catch (e) {
    if (e.killed) return text(`Compile timed out after ${COMPILE_TIMEOUT / 1000} s`, true);
    const log = `${e.stdout || ''}\n${e.stderr || ''}`, errs = log.split('\n').filter((l) => /^(error|!)|error:/i.test(l));
    return text(`Compile failed.\n${errs.slice(0, 20).join('\n')}\n--- end of log ---\n${tail(log, 40)}`, true);
  }
}

// our four tools: name -> {description, shape (zod), run}
const toolSpecs = (z) => ({
  read_file: { run: readFile, description: 'Read a file in the job folder, or a skill file under ../../.claude/skills/devreport/. Text comes back as plain lines (offset/limit page through long files); images (png/jpg/gif/webp) as images; a PDF as page images (pages "3" or "2-5", at most 10 at once) plus its page count. A folder lists its entries.',
    shape: { path: z.string(), offset: z.number().int().min(1).optional().describe('first line (1-based), text only'), limit: z.number().int().min(1).optional().describe('number of lines, text only'), pages: z.string().optional().describe('PDF pages, e.g. "3" or "1-4"') } },
  write_file: { run: writeFile, description: 'Create or overwrite a file in the job folder (creates parent folders).', shape: { path: z.string(), content: z.string() } },
  edit_file: { run: editFile, description: 'Replace an exact string in a file in the job folder. old_string must occur exactly once unless replace_all is true.',
    shape: { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() } },
  compile: { run: compile, description: 'Run `tectonic main.tex` (or template-test.tex) in the job folder and return the errors or warnings.', shape: { file: z.enum(COMPILABLE).optional().describe('default main.tex') } },
});

function systemPrompt(jobDir) {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
  const rel = path.relative(jobDir, SKILL_DIR).split(path.sep).join('/');
  return `You are devreport's build agent. You work in one job folder (the current directory) through four tools and nothing else: read_file, write_file, edit_file and compile. There is no shell and no other tool.

In the devreport skill below, Read means read_file, Write means write_file, Edit means edit_file, and running \`tectonic X.tex\` means compile (file "X.tex"). The skill is already loaded (it is below), so when a prompt says to load it with the Skill tool, just follow it. There is no humanizer skill: skip its optional pass. The skill's other files (charts.md, template.md, themes/) are read-only at ${rel}/<file>, e.g. read_file("${rel}/charts.md"). To ask the user questions, write questions.json as the skill says. Paths are relative to the job folder; anything outside it is refused. Call independent tools in parallel when you can (e.g. read several files at once).

${skill}`;
}

/** MCP-shaped result -> AI SDK tool output for the model
 * @returns {import('@ai-sdk/provider-utils').ToolResultOutput} */
const toModelOutput = ({ output: o }) => (o.isError
  ? { type: 'error-text', value: o.content.map((c) => c.text || '').join('\n') }
  : { type: 'content', value: o.content.map((c) => (c.type === 'image' ? { type: 'image-data', data: c.data, mediaType: c.mimeType } : { type: 'text', text: c.text })) });

async function main() {
  const argv = process.argv.slice(2), arg = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  const prompt = arg('-p');
  if (!prompt) { console.error('usage: node agent.js [--resume <session>] -p "<prompt>"'); process.exit(2); }
  const jobDir = process.cwd(), resumeId = arg('--resume'), started = Date.now();
  const spec = process.env.DEVREPORT_MODEL || 'claude-code:opus';
  const [provider, ...rest] = spec.split(':'), modelId = rest.join(':');
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  let saved = null;
  if (resumeId) { // no matching history: exit without an init line, and server.js starts a fresh run
    try { saved = JSON.parse(await fsp.readFile(path.join(jobDir, MESSAGES), 'utf8')); } catch {}
    if (saved?.sessionId !== resumeId) { console.error(`No saved session ${resumeId}`); process.exit(1); }
  }
  const sessionId = saved?.sessionId || crypto.randomUUID();

  globalThis.AI_SDK_LOG_WARNINGS = false; // stderr is the server's error tail, keep it for real errors
  const { streamText, tool, isStepCount } = await import('ai');
  const { z } = await import('zod');
  const wrap = (fn) => async (args) => { try { return await fn(args, jobDir); } catch (e) { return text(e.message, true); } };
  const specs = toolSpecs(z), system = systemPrompt(jobDir);
  const abort = new AbortController(); // the server's timeout SIGTERMs us: stop the model (and claude-code's subprocess) too
  process.on('SIGTERM', () => { abort.abort(); setTimeout(() => process.exit(1), 3000); });

  let model, tools, prefix = '', extra = {};
  /** @type {{tools?: string[]} | null} */ let ccInit = null; // Claude Code's init message
  if (provider === 'claude-code') {
    // Claude Code runs the loop and its own tools; ours go in as an in-process MCP server, and every built-in is off
    const { claudeCode, createCustomMcpServer } = await import('ai-sdk-provider-claude-code');
    const server = createCustomMcpServer({ name: 'devreport', version: '1.0.0',
      tools: Object.fromEntries(Object.entries(specs).map(([name, t]) => [name, { description: t.description, inputSchema: z.object(t.shape), handler: wrap(t.run) }])) });
    prefix = 'mcp__devreport__';
    model = claudeCode(modelId || 'opus', {
      cwd: jobDir,
      systemPrompt: system,
      tools: [], // no built-in tools at all
      mcpServers: { devreport: server },
      strictMcpConfig: true, // no MCP servers from the user's config or account
      allowedTools: Object.keys(specs).map((n) => prefix + n),
      permissionMode: 'dontAsk', // anything not allowed above is denied, never prompted
      settingSources: [], // no user/project settings, hooks, plugins, skills or CLAUDE.md
      verbatimPrompts: true, // no @file expansion or slash commands from prompt text
      maxTurns: MAX_STEPS,
      resume: saved?.claudeSession, // its own transcript is richer than our replayed one (images, exact tool results)
      onSdkMessage: (m) => { if (m.type === 'system' && m.subtype === 'init') ccInit = m; },
    });
  } else if (provider === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY is not set'); process.exit(1); }
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
    model = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(modelId);
    tools = Object.fromEntries(Object.entries(specs).map(([name, t]) => [name, tool({ description: t.description, inputSchema: z.object(t.shape), execute: wrap(t.run), toModelOutput })]));
    extra = { instructions: system, tools, stopWhen: isStepCount(MAX_STEPS) };
  } else { console.error(`Unknown provider in DEVREPORT_MODEL=${spec} (use claude-code:<model> or openrouter:<model>)`); process.exit(2); }

  const history = saved?.messages || [];
  const userMsg = { role: 'user', content: prompt };
  // claude-code resumes its own session, so it only needs the new message; other providers get the whole history back
  const messages = provider === 'claude-code' && saved?.claudeSession ? [userMsg] : [...history, userMsg];

  out({ type: 'system', subtype: 'init', session_id: sessionId, model: spec, cwd: jobDir });
  let note = '', lastText = '', calls = 0, steps = 0, failed = null, claudeSession = saved?.claudeSession, turns;
  const name = (n) => (prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n);
  const flushText = () => { if (note.trim()) { out({ type: 'assistant', message: { content: [{ type: 'text', text: note }] } }); lastText = note; } note = ''; };
  const result = streamText({ model, messages, abortSignal: abort.signal, ...extra });
  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': note += part.text; break;
        case 'tool-call':
          flushText(); calls++;
          out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: part.toolCallId, name: name(part.toolName), input: part.input }] } });
          break;
        case 'tool-result': case 'tool-error':
          out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: part.toolCallId, is_error: part.type === 'tool-error' || !!part.output?.isError }] } });
          break;
        case 'finish-step': {
          flushText(); steps++;
          const cc = part.providerMetadata?.['claude-code'];
          if (cc?.sessionId) claudeSession = cc.sessionId;
          if (cc?.numTurns) turns = cc.numTurns;
          break;
        }
        case 'error': failed = part.error; break;
      }
    }
    flushText();
    const response = await result.response;
    await fsp.writeFile(path.join(jobDir, MESSAGES), JSON.stringify({ sessionId, model: spec, claudeSession, messages: [...history, userMsg, ...response.messages] }));
  } catch (e) { failed ||= e; }
  if (ccInit) { // proof of the sandbox: what Claude Code says the model can call
    const tools = ccInit.tools || [];
    console.error(`[agent] claude-code tools: ${tools.join(', ') || '(none)'}`);
    if (tools.some((t) => !t.startsWith(prefix))) failed ||= new Error(`Claude Code exposed tools beyond ours: ${tools.join(', ')}`);
  }
  const msg = failed && String(failed.message || failed);
  if (msg) console.error(msg);
  out({ type: 'result', subtype: failed ? 'error' : 'success', is_error: !!failed, result: failed ? msg : lastText, session_id: sessionId,
    num_turns: turns || steps, tool_calls: calls, duration_ms: Date.now() - started });
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
module.exports = { resolveInJob, compile, editFile, writeFile, readFile, SKILL_DIR };
