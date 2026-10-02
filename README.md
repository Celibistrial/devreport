# devreport

Turn a messy project folder into a polished PDF report or slide deck.

Drop in dev logs, notes, a CSV, screenshots, a `.zip`, or just paste a GitHub link. devreport analyses it with plain code, then has Claude Code write and compile a LaTeX report or Beamer deck of the length you pick, live in your browser. It only asks you something when your files don't say what the project is or who it's for.

It's for student builders who have to write up a hackathon, coursework or side project and would rather keep building.

Samples: [report (Paper theme)](samples/report-paper.pdf) · [slides (Midnight theme)](samples/slides-midnight.pdf)

## How it works

```
upload / zip / GitHub link
  → collect.js     parses git history, logs, tables, notes, images → data/*.csv + facts.json
  → claude -p      reads everything; if something essential is missing, writes questions.json and stops
  → you answer     (only then) answers saved as answers.md, the same Claude session resumes
  → claude         writes main.tex, compiles with tectonic, fixes errors, humanizes prose, recompiles
  → main.pdf       shown inline, with the .tex to download
```

- **Charts only plot computed data.** Every chart is pgfplots reading a CSV that `collect.js` computed (`\addplot table{data/commits_per_day.csv}`). Claude never types a number into a chart, and stat numbers come from `facts.json`.
- **Our code does the analysis, Claude writes the prose.** Milestones from git history (vendored and generated code excluded), the likely entry points of the code, recurring errors (numbers/IDs normalized so repeats group together), and column-type detection for your own CSV/JSON are all deterministic and tested. Commit counts and lines of code aren't treated as evidence of anything: they only show up as a timeline or an appendix sentence.
- **Asks only when it has to.** Claude reads the README, notes and code first. If it still can't tell what the project does, or the problem and who it's for, it asks up to 3 questions in the feed (or one about results when there's no evidence at all). Answer or skip; either way it carries on in the same session (`--resume`) and asks at most once. Most repos with a README get no questions. Lessons and what's next are never asked for: without a source, those sections are left out.
- **Length is a target.** Pick 5–25 slides or 2–10 pages. Claude aims within one either way, goes shorter rather than pad, and cuts the least important sections when there's too much.
- **Locked-down agent.** Claude Code runs headless with only `Read,Write(./**),Edit(./**),Bash(tectonic:*),Skill`: no general shell, and it can only write inside the job folder. Uploaded content is treated as data, never instructions.
- **Safe intake.** Zips are size-checked before extracting (zip bombs), path-escaping entries are rejected, symlinks are deleted. GitHub URLs are validated and cloned without a shell, with a timeout.
- **Themes, switchable after the build.** Paper (serif, academic) and Midnight (dark, neon, terminal) work for reports and slides; slides also get five popular Beamer themes: Metropolis, Moloch (its maintained fork, dark variant), Focus, Trigon and the built-in Madrid. Each theme is a small adapter `.sty` exposing the same `dr*` colours, chart styles, stat tiles and type sizes, and `main.tex` only says `\input{theme.tex}`. So once a deck exists, clicking another theme rewrites that one line and reruns `tectonic` (about 1.2 s, no Claude); each compiled theme is cached, so switching back is instant.
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

## Third-party credits

- [humanizer](.claude/skills/humanizer/) skill, MIT (see its LICENSE)
- [Metropolis](https://github.com/matze/mtheme) Beamer theme by Matthias Vogelgesang, loaded from tectonic's TeX bundle (CC BY-SA 4.0)
- [Moloch](https://github.com/jolars/moloch) Beamer theme by Johan Larsson, vendored in `themes/vendor/moloch/` (CC BY-SA 4.0, see its LICENSE)
- [Focus](https://github.com/elauksap/focus-beamertheme) Beamer theme by Pasquale Claudio Africa, vendored in `themes/vendor/focus/` (GPL-3.0, see its LICENSE)
- Trigon Beamer theme (CTAN, loaded from tectonic's bundle) and Beamer's built-in Madrid theme
- [pgfplots](https://ctan.org/pkg/pgfplots), [pgf-pie](https://ctan.org/pkg/pgf-pie) and [tectonic](https://tectonic-typesetting.github.io)

## AI disclosure

Built with Claude Code as a pair programmer, and Claude Code (headless) is the runtime that writes each report. The collector, intake, server and UI are ordinary code you can read and test.

## License

© 2026 Gaurav. All rights reserved; see [LICENSE](LICENSE). Source is public for hackathon judging. Third-party themes and skills keep their own licenses (listed above).
