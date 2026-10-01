# devreport handoff

Drop messy dev logs, notes, git history and screenshots into a browser page and get back a polished LaTeX PDF report or Beamer slide deck. Charts come from computed data, the prose is humanized, and you can pick a theme or upload your own PPT template. The backend is the real Claude Code CLI running headless.

## Hackathon

- **Event:** Beginner's Paradise - FirstCommit, https://firstcommit.devpost.com/
- **Deadline:** Oct 2, 2026, 12:00pm EDT = **9:30pm IST**
- **Prizes:** Champion $292, Most Ambitious $292, Most Creative $120, Best Web/App Experience $120, Best Design $120
- **Judging:** Learning & Growth, Creativity, Execution, Technical Understanding (can you explain how it works), Presentation
- **Must submit:**
  - Public GitHub repo with **multiple meaningful commits** (a single bulk upload is penalized)
  - 3–5 min demo video
  - Project description: what it is, the problem, who it's for
  - README with setup steps
- **AI use is allowed but must be disclosed** in the description. Judges value the builder's understanding over AI-generated code.
- **Eligibility:** students aged 13–21 (confirmed).

## Decisions made

1. **Narrow user:** student builders turning messy dev logs and project history into a report or slides, not "any idea → document". This answers the "it's an LLM wrapper" risk.
2. **Our code does the analysis, Claude writes the prose.** The deterministic collectors are the Technical Understanding story.
3. **Charts can't show made-up data.** pgfplots plots CSV files computed by `collect.js` (`\addplot table {data/x.csv}`). Claude never types a number into a chart.
4. **Backend = Claude Code headless** (`claude -p`), not the Claude API. There's no API key.
5. **No public live generation.** Hosting it so strangers run on the owner's Claude Code subscription breaks Anthropic's terms, and the only server available is a tiny shared box. Anyone who clones the repo runs it with **their own** Claude Code login.
6. **Live link = static showcase** at a static site: pre-made sample reports (including one devreport generated about itself), downloadable PDFs and install steps.
7. **Dogfood demo finale:** run devreport on its own repo so it generates its own report and Devpost write-up.
8. **Repo:** public, owned by GitHub account **Celibistrial**.
   - Local commits use the email `82810795+Celibistrial@users.noreply.github.com`.

## Architecture

```
Browser                       server.js (Node stdlib http)            Claude Code
───────                       ────────────────────────────            ───────────
drop files + notes  ──POST──▶ save to jobs/<id>/input/
pick Report | Slides          run collect.js → data/*.csv
pick theme / upload .pptx     run pptx.js → template/ (if pptx)
                              spawn claude -p in jobs/<id>/ ────────▶ read inputs
live progress feed  ◀──SSE─── forward stream-json steps     ◀──────── write main.tex
                                                                      tectonic compile
                                                                      fix errors, recompile
                                                                      humanizer on prose
inline PDF + .tex   ◀──GET─── serve main.pdf                ◀──────── final compile
```

### The Claude Code call

```bash
claude -p "<job instructions>" --output-format stream-json --verbose \
  --allowedTools "Read,Write,Edit,Bash(tectonic:*),Skill"
```

- Runs with `cwd` set to `jobs/<id>/`, so project skills come from the repo's `.claude/skills/`.
- Tools are locked down: no general shell on uploaded content.
- Each run takes roughly 1–3 min, since it may compile and fix several times. The UI streams each step so the wait looks like progress.
- Confirmed: Claude Code 2.1.287 supports `-p`, `--output-format`, `--json-schema` and `--allowedTools`.

## Files

| File | Job |
|---|---|
| `collect.js` | Deterministic parsing of inputs into `data/*.csv` plus `facts.json` |
| `pptx.js` | Unzips a .pptx and extracts colors, fonts, media, layout boxes and the thumbnail into `template/` |
| `server.js` | Uploads, jobs, spawning `claude`, SSE progress, file serving |
| `index.html` | Drop zone, Report/Slides toggle, theme picker, PPT upload, live feed, inline PDF |
| `test.js` | `node:test` tests for the collector and the pptx extractor, using fixtures |
| `.claude/skills/devreport/SKILL.md` | Pipeline rules for Claude: outline → write tex → compile → fix → humanize → recompile |
| `.claude/skills/devreport/themes/*.sty` | Theme files (report + beamer) |
| `.claude/skills/devreport/charts.md` | Which pgfplots chart fits which data |
| `.claude/skills/humanizer/` | Vendored humanizer skill (MIT; keep its LICENSE). Source: `~/.agents/skills/humanizer` |

Dependencies: none for the server. Chart.js isn't needed, since charts are pgfplots inside LaTeX.

## Collector rules (`collect.js`)

| Input | Parsing | Output CSVs / charts |
|---|---|---|
| git history (`git log --numstat`) | Commits/day, lines added and removed, most-edited files, hour of day, feat/fix/docs ratio from messages | commits over time (line), work-hour heatmap, top files (bar), commit types (pie) |
| `.log`, terminal output | Regex for timestamps (ISO, syslog, `[HH:MM:SS]`) and ERROR/WARN/INFO levels. Group repeated errors by replacing numbers, hex and IDs with placeholders | errors over time, top 5 recurring errors (bar) |
| CSV / JSON (arrays of objects) | Detect each column's type: date / number / category | chart chosen by the rules below |
| `.md`, `.txt` notes | Passed through raw (truncated) | none |
| images | Copied into the job and given IDs | placed and captioned by Claude |

**Chart picker:**
- date + number → line
- category + number → bar
- single number column → histogram
- 6 or fewer categories as parts of a whole → pie/doughnut

## Themes

There are 4 presets. Each is one `.sty` usable by both the article and beamer documents:

| Theme | Look |
|---|---|
| **Paper** | Serif, cream, academic |
| **Midnight** | Dark slides, neon accent, terminal-style dev look |
| **Minimal** | Swiss: white space, one accent color |
| **Campus** | Bold colors, rounded blocks, hackathon energy |

## PPT template import (stretch goal)

1. Unzip the `.pptx` and parse:
   - `ppt/theme/theme1.xml`: `a:clrScheme` (hex palette) and `a:fontScheme` (heading/body fonts)
   - `ppt/media/*`: logos and backgrounds
   - `ppt/slideLayouts/*.xml`: title and body box positions
   - `docProps/thumbnail.jpeg`: the slide preview
2. Write `template/template.json` plus the media files.
3. Claude generates a custom beamer theme from the JSON. It compiles a test slide, compares it with the thumbnail (Read the image) and adjusts.
4. Fonts: tectonic is XeTeX-based, so `fontspec` can use system fonts. Fall back to a close match when a font is missing.
5. **Limits:** it copies colors, fonts, logos and layout, but it won't be pixel-perfect. No complex shapes or animations. There's no LibreOffice on this machine, so the only visual reference is the thumbnail.

## Build order (cut from the bottom if time runs short)

| # | Part | Est. | Running total |
|---|---|---|---|
| 1 | `collect.js` + tests | 1 hr | 1 hr |
| 2 | devreport skill + base templates | 1 hr | 2 hrs |
| 3 | `server.js` + streaming | 1.5 hrs | 3.5 hrs |
| 4 | `index.html` UI | 1 hr | 4.5 hrs |
| 5 | 4 themes | 1 hr | 5.5 hrs |
| 6 | Dogfood run + README + showcase site | 1 hr | 6.5 hrs |
| 7 | PPT import (stretch) | 1.5 hrs | 8 hrs |
| — | Demo video (owner records it) | 1 hr | — |

**Commit after each part.** The commit history is judged.

## Environment checked (Oct 2, 2026, ~3am IST)

- Node v26.8.2, npm 11.19.1
- `tectonic` at `/opt/homebrew/bin/tectonic`. Compiled a pgfplots bar chart test in 0.6 s.
- No pdflatex, latexmk or LibreOffice. Keynote is present but unused.
- `unzip` and `python3` are available.
- Humanizer skill: `~/.claude/skills/humanizer` → `~/.agents/skills/humanizer`, MIT, v3.0.0


## Demo video outline (3–5 min)

1. **Problem (20s):** a messy folder of logs, notes and screenshots, and nobody wants to write the report.
2. **Drop it in (30s):** pick Report, pick a theme, hit Generate.
3. **Live feed (40s, sped up):** reading, writing, compile error, fixed, humanizing.
4. **Result (40s):** the PDF with real charts. Switch to Slides. Show a PPT template being matched.
5. **How it works (60s):** collectors → CSV → pgfplots (no fake numbers), the agent compile/fix loop, the locked-down tools.
6. **Finale (30s):** devreport generates its own report.
7. **Learned / challenges (30s).** Disclose that Claude Code was used for building and is the runtime.

## Status

- [x] Idea, scope and architecture decided
- [x] Repo dir created (`~/dev/devreport`), git initialized
- [ ] Part 1: collector + tests ← **next**
