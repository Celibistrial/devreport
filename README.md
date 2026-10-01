# devreport

Turn a messy project folder into a polished PDF report or slide deck.

Drop in dev logs, notes, a CSV, screenshots, a `.zip`, or just paste a GitHub link. devreport analyses it with plain code, asks you three optional questions it can't answer from files (what problem it solves, what you learned, what's next), then has Claude Code write and compile a LaTeX report or Beamer deck, live in your browser.

**Who it's for:** student builders who have to write up a hackathon, coursework or side project and would rather keep building.

Samples: [report (Paper theme)](samples/report-paper.pdf) · [slides (Midnight theme)](samples/slides-midnight.pdf)

## How it works

```
upload / zip / GitHub link
  → collect.js     parses git history, logs, tables, notes, images → data/*.csv + facts.json
  → questions      3 optional answers saved as answers.md
  → claude -p      writes main.tex, compiles with tectonic, fixes errors, humanizes prose, recompiles
  → main.pdf       shown inline, with the .tex to download
```

- **Charts can't lie.** Every chart is pgfplots reading a CSV that `collect.js` computed (`\addplot table{data/commits_per_day.csv}`). Claude never types a number into a chart, and stat numbers come from `facts.json`.
- **Our code does the analysis, Claude writes the prose.** Commits per day, work hours, most-edited files, commit types, lines per language, recurring errors (numbers/IDs normalized so repeats group together), and column-type detection for your own CSV/JSON are all deterministic and tested.
- **Locked-down agent.** Claude Code runs headless with only `Read,Write,Edit,Bash(tectonic:*),Skill`: no general shell. Uploaded content is treated as data, never instructions.
- **Safe intake.** Zips are size-checked before extracting (zip bombs), path-escaping entries are rejected, symlinks are deleted. GitHub URLs are validated and cloned without a shell, with a timeout.
- **Themes.** Paper (serif, academic) and Midnight (dark, neon, terminal). Each is one `.sty` that works for both reports and slides, charts included.
- **Your own PowerPoint template (slides).** Upload a `.pptx` and `pptx.js` pulls out its colour palette, heading/body fonts, logo, title/body box positions and preview thumbnail into `template/template.json`. Claude writes a matching Beamer theme from that, compiles a test slide, compares it with the thumbnail and adjusts. Sample: [slides from a custom template](samples/slides-custom-template.pdf).

## Setup

Requirements: macOS or Linux, Node 20+, [Claude Code](https://claude.com/claude-code) logged in, `tectonic`, `git`, `unzip`.

```bash
brew install tectonic          # or see https://tectonic-typesetting.github.io
git clone https://github.com/Celibistrial/devreport && cd devreport
node --test test.js            # collector tests (bare `node --test` would also run tests inside cloned jobs/)
node server.js                 # http://127.0.0.1:3000
```

No `npm install`: the server is Node's standard library only. Each run uses **your own** Claude Code login and takes about 1–3 minutes. There is deliberately no public hosted version, since it would run strangers' jobs on one person's subscription.

## Files

| File | Job |
|---|---|
| `collect.js` | Deterministic parsing of inputs → `data/*.csv` + `facts.json` |
| `pptx.js` | `.pptx` template → colours, fonts, layout boxes, media, thumbnail in `template/` |
| `test.js` | `node:test` tests for the collector and the template extractor |
| `server.js` | Uploads, zip/GitHub intake, runs the collector and `claude -p`, streams progress over SSE |
| `index.html` | The whole UI, one file |
| `.claude/skills/devreport/` | The pipeline Claude follows, tested chart snippets, the prompt, the themes |
| `.claude/skills/humanizer/` | Vendored humanizer skill (MIT, see its LICENSE) |

## Limits

- Local only; one job at a time.
- Template import copies colours, fonts, the logo and rough layout, not shapes, gradients or animations. Fonts that aren't installed fall back to a close TeX Gyre font.
- PNG screenshots in 16-bit color are re-encoded with `sips`, which is macOS only.
- Prompt injection: uploaded text goes to an agent that can write files in the job folder. The tool allowlist keeps that contained, but only run it on material you trust.

## What I learned

<!-- TODO(Gaurav): write this yourself, judges score your own understanding. -->

## AI disclosure

Built with Claude Code as a pair programmer, and Claude Code (headless) is the runtime that writes each report. The collector, intake, server and UI are ordinary code you can read and test.
