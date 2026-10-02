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
6. **No live site.** Sample PDFs (including one devreport generated about itself) are committed to the repo under `samples/` and linked from the README.
7. **Dogfood demo finale:** run devreport on its own repo so it generates its own report and Devpost write-up.
8. **Repo:** public, owned by GitHub account **Celibistrial**.
   - Local commits use the email `82810795+Celibistrial@users.noreply.github.com`.

## Architecture

```
Browser                       server.js (Node stdlib http)            Claude Code
───────                       ────────────────────────────            ───────────
drop files / .zip   ──POST──▶ save to jobs/<id>/input/ (unzip .zip)
or GitHub URL                 or git clone → jobs/<id>/input/repo/
pick Report | Slides          run collect.js → data/*.csv
answer 3 fixed      ──POST──▶ save answers.md to input/
optional questions
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
  --allowedTools "Read,Write(./**),Edit(./**),Bash(tectonic:*),Skill"
```

- Runs with `cwd` set to `jobs/<id>/`, so project skills come from the repo's `.claude/skills/`.
- Tools are locked down: no general shell on uploaded content. `Write(./**)`/`Edit(./**)` are path rules relative to the cwd: tested with `claude -p`, a Write to `../escape.txt` or `/tmp/x` is denied while `main.tex` and `template/x.sty` work (bare `Write` allowed the escape).
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
| git history (`git log --numstat`) | Commits/day, milestones, lines added/removed, most-edited files, hour of day, commit types; vendored paths excluded | milestones in facts; commits/day as timeline backdrop only; the rest as CSVs, not charts |
| `.log`, terminal output | Regex for timestamps (ISO, syslog, `[HH:MM:SS]`) and ERROR/WARN/INFO levels. Group repeated errors by replacing numbers, hex and IDs with placeholders | errors over time, top 5 recurring errors (bar) |
| CSV / JSON (arrays of objects) | Detect each column's type: date / number / category | chart chosen by the rules below |
| `.md`, `.txt` notes | Passed through raw (truncated) | none |
| images | Copied into the job and given IDs | placed and captioned by Claude |
| `.zip` | Unzipped by the server into `input/`, then each file goes through the rows above | (per file) |
| GitHub repo / any repo folder | `git log` from the repo; README and `package.json`-style manifests passed through as notes; lines of code per language from file extensions | everything from the git row; `languages.csv` written but not charted |

**Chart picker:**
- date + number → line
- category + number → bar
- single number column → histogram
- 6 or fewer categories as parts of a whole → pie/doughnut

## Intake and gap check

**Accepted inputs:** loose files, a `.zip`, or a public GitHub URL (or any mix).

- **Zip:** cap upload at ~50 MB, then sum sizes from `unzip -l` and reject if the extracted total is over ~200 MB (zip bomb). `unzip -q x.zip -d input/`. Info-ZIP skips `../` paths by default; still reject any entry that resolves outside `input/`. Afterwards `find input -type l -delete` so Claude's `Read` can't follow a symlink out of the job.
- **Untrusted `.git/`:** a zip may contain a repo. Only ever run `git log` on it, with `GIT_CONFIG_NOSYSTEM=1`; never `git status` or anything that runs hooks.
- **GitHub URL:** strip a trailing `.git`, `/tree/<branch>...` and `/`, then it must match `^https://github\.com/[\w.-]+/[\w.-]+$`. Run `git clone --single-branch <url> input/repo` via `execFile` (no shell) with `GIT_TERMINAL_PROMPT=0` so a private repo fails fast instead of hanging. Full history is needed for `git log --numstat`. Cap with a timeout (~60 s).

**Questions form** (fixed, not a Claude call — deterministic for the demo, no extra wait):

1. After upload, the UI always shows 4 optional questions: *What problem does it solve and who is it for?*, *What result are you proudest of, and how did you measure it?*, *What did you learn / what was hard?*, *What's next?*
2. Answers are saved as `input/answers.md` and treated as notes. Blank answers are fine.
3. If a slot is still empty, Claude leaves it out; it never makes up facts.
4. Upgrade later (only if time): a `claude -p --json-schema` gap check that asks only for what's missing, defaulting to "enough" on timeout.

**Content checklist (what a full deck/report needs):**

| Slot | Usually found in |
|---|---|
| What it is, one line | README |
| Problem + who it's for | README, notes |
| How it works | code structure, README |
| Results / what works | git log, logs, screenshots |
| Challenges + what you learned | commit messages ("fix"), error logs, notes |
| What's next | notes, TODOs |

Problem/audience, lessons learned and what's next are the slots most often missing, which is why the form asks exactly those.

## Themes

Ship 2 presets (Paper, Midnight). Minimal and Campus only if there's time left. Each is one `.sty` usable by both the article and beamer documents:

| Theme | Look |
|---|---|
| **Paper** | Serif, cream, academic |
| **Midnight** | Dark slides, neon accent, terminal-style dev look |
| **Minimal** | Swiss: white space, one accent color |
| **Campus** | Bold colors, rounded blocks, hackathon energy |

## PPT template import (late stage: only after Parts 1–6 ship)

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
| 0 | **Proof first (20 min):** hand-write one `main.tex` + one theme that compiles with a real CSV; run `claude -p --allowedTools ... --output-format stream-json` from `jobs/x/` and confirm project skills load | 0.33 hrs | 0.33 hrs |
| 1 | `collect.js` + tests (incl. repo folder: languages, README) | 1.25 hrs | 1.6 hrs |
| 2 | devreport skill + base templates (**Report first**) | 1 hr | 2.6 hrs |
| 3 | `server.js` + streaming + zip/GitHub intake | 1.5 hrs | 4.1 hrs |
| 4 | `index.html` UI (incl. URL box + fixed questions form) | 1.25 hrs | 5.35 hrs |
| 5 | 2 themes (Paper, Midnight); Slides only if done by 6pm IST | 0.5 hrs | 5.85 hrs |
| 6 | Dogfood run + README (setup, "What I learned", prompt-injection note) + `samples/` PDFs | 1 hr | 6.85 hrs |
| 7 | PPT import (late stage) | 1.5 hrs | 8.35 hrs |
| — | Demo video (owner records it) + Devpost form | 1.5 hrs | — |

**Hard stop building at 7:45pm IST.** Screen-record each part as it starts working so the video exists even if the UI isn't finished. Demo on one fixed, prepared repo, not a random URL.

**Commit after each feature, not just each part.** The commit history is judged. `.gitignore` the `jobs/` folder so uploads never reach the public repo.

## Environment checked (Oct 2, 2026, ~3am IST)

- Node v26.8.2, npm 11.19.1
- `tectonic` at `/opt/homebrew/bin/tectonic`. Compiled a pgfplots bar chart test in 0.6 s.
- No pdflatex, latexmk or LibreOffice. Keynote is present but unused.
- `unzip` and `python3` are available.
- Humanizer skill: `~/.claude/skills/humanizer` → `~/.agents/skills/humanizer`, MIT, v3.0.0

## Demo video outline (3–5 min)

1. **Problem (20s):** a messy folder of logs, notes and screenshots, and nobody wants to write the report.
2. **Drop it in (30s):** paste a GitHub link (or drop a zip), pick Slides, pick a theme. devreport asks 2–3 questions it couldn't answer from the repo; answer them, hit Generate.
3. **Live feed (40s, sped up):** reading, writing, compile error, fixed, humanizing.
4. **Result (40s):** the PDF with real charts. Switch to Slides if built. Show PPT matching only if Part 7 shipped.
5. **How it works (60s):** collectors → CSV → pgfplots (no fake numbers), the agent compile/fix loop, the locked-down tools.
6. **Finale (30s):** devreport generates its own report.
7. **Learned / challenges (30s).** Disclose that Claude Code was used for building and is the runtime.

## Status

- [x] Idea, scope and architecture decided
- [x] Repo dir created (`~/dev/devreport`), git initialized
- [x] Plan reviewed (Fable): cut gap-check call → fixed form, 2 themes, no showcase site, PPT import last
- [x] Part 0: proof — skills load from `jobs/<id>/` cwd, tectonic runs under the allowlist; themes load via `\usepackage{../../.claude/skills/devreport/themes/devreport-<theme>}`
- [x] Part 1: collector + tests (`node --test test.js`, not bare `node --test`: that also runs tests inside cloned jobs)
- [x] Part 2: devreport skill, tested chart snippets, prompt.txt (first line = ALLOWED_TOOLS)
- [x] Part 3–4: server.js + index.html (zip/GitHub intake, fixed questions form, SSE feed with cost)
- [x] Part 5: Paper + Midnight themes
- [x] E2E through the real UI: GitHub link → report (~2 min), zip → slides (~1 min, ~$0.5)
- [x] Part 6: dogfood samples in `samples/` (regenerate before submitting so they show the full day of commits)
- [ ] README "What I learned" ← owner writes this
- [ ] Push repo public (check `gh auth status` → Celibistrial first)
- [x] Part 7: PPT import: `pptx.js` + test, template card in the UI, `template.md` in the skill, sample `samples/slides-custom-template.pdf`
- [ ] Demo video + Devpost form

Known small issues: error grouping turns `sqlite3` into `sqlite<n>`; zips with a top-level folder unpack to `input/x/x/` (cosmetic).

## Interface contract (shared by all parts)

**Job folder** `jobs/<id>/`:
```
job.json        {"id","kind":"report"|"slides","theme":"paper"|"midnight"|"custom","template"?:true,"status","createdAt"}
template/       pptx.js output when a .pptx was uploaded (slides only): template.json, media/, thumbnail.jpeg
input/          uploaded files, unzipped zips, input/repo/ for a cloned GitHub repo, input/answers.md
data/*.csv      written by collect.js
images/         images copied by collect.js as img1.png, img2.jpg, ...
facts.json      written by collect.js
main.tex/.pdf   written by Claude
```

**`node collect.js <jobDir>`** (also `module.exports = { collect }`, `collect(jobDir)` returns facts). Reads `input/**`, writes `data/` + `images/` + `facts.json`. Exit 0 even if inputs are thin.

**CSV format:** header row, comma separated, commas/quotes/newlines stripped from cells (pgfplots ignores CSV quoting), numbers plain. Fixed names:
- `commits_per_day.csv` date,commits,added,removed (date = YYYY-MM-DD). Charted only as the timeline backdrop.
- `commit_hours.csv` hour,commits (0–23, all 24 rows). Written, not listed in `charts`.
- `top_files.csv` file,changes (top 10). Written, not listed in `charts`.
- `commit_types.csv` type,count (feat/fix/docs/refactor/test/chore/other). Written, not listed in `charts`.
- `languages.csv` language,lines. Written, not listed in `charts`.
- `errors_over_time.csv` bucket,errors,warnings
- `top_errors.csv` error,count (top 5, normalized pattern)
- user CSV/JSON tables: `table_<slug>.csv`

**`facts.json`:**
```json
{
  "project": {"name": "", "readme": "first ~4000 chars or null"},
  "repo": {"commits": 0, "authors": [], "firstDate": "", "lastDate": "", "activeDays": 0, "days": 0,
           "milestones": [{"date": "YYYY-MM-DD", "message": "commit subject"}],
           "appendix": {"linesAdded": 0, "linesRemoved": 0}} | null,
  "logs": {"lines": 0, "errors": 0, "warnings": 0} | null,
  "code": {"files": [{"path": "input/x/server.py", "lang": "Python", "lines": 38}], "entry": ["input/x/server.py"]} | null,
  "charts": [{"csv": "data/commits_per_day.csv", "kind": "line|bar|pie|hist|heatmap", "x": "date", "y": "commits", "title": "Commits per day"}],
  "notes": [{"file": "input/notes.md", "text": "truncated ~6000 chars"}],
  "answers": "contents of input/answers.md or null",
  "images": [{"id": "img1", "file": "images/img1.png", "original": "input/shot.png"}]
}
```
Only emit a chart when its CSV has ≥ 2 data rows. `charts` holds only `commits_per_day` (timeline backdrop), `errors_over_time`, `top_errors` and user `table_*` charts; LOC, commit counts and commit history are not quality metrics, so the other git CSVs stay out of it.

**Vendored code is not the project.** Paths under `node_modules/`, `vendor/`, `dist/`, `build/`, `.claude/skills/` (and other build dirs), lockfiles and minified/map files are left out of `languages.csv`, `top_files.csv` and line counts. Inside a repo, gitignored files (`git ls-files --others --ignored --exclude-standard`, e.g. a `jobs/` folder of clones) are skipped entirely, and a `.git` nested inside another repo is not read. A commit that only touched vendored paths doesn't count towards `commits`, `firstDate`, `authors` or milestones (a commit to the repo's own `.claude/skills/` still does).
- `repo.authors`: authors with ≥ 2 counted commits, or all of them if there are < 5 commits.
- `code.files`: ≤ 40 source files (not docs/config, not vendored), entry points first, then by size, tests last. `code.entry`: ≤ 8 likely entry points: files a manifest names (package.json main/bin/scripts, pyproject scripts), names like main/app/server/index/cli/__main__/client, then the largest non-test files. Claude reads these when the README and notes are thin.
- `repo.milestones`: ≤ 8, chronological. The first commit, tagged commits, then the largest feat/add commits (by lines changed) spread over equal time windows of the span.

**Claude call** (server, cwd = `jobs/<id>/`):
```
claude -p "<prompt from .claude/skills/devreport/prompt.txt with {{kind}} {{theme}} filled>" \
  --output-format stream-json --verbose --allowedTools "<from prompt.txt notes>"
```
Theme files live in `.claude/skills/devreport/themes/devreport-<theme>.sty`; how they reach the job (copy vs path) is decided by Part 0/2 and written in SKILL.md.
