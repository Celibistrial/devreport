# Chart snippets (tested with tectonic + both themes)

Every chart reads its numbers from a CSV listed in `facts.json` → `charts[]`. Swap the file name and
column names for the chart's `csv`, `x`, `y`. Never type a number into a chart. The theme already sets
colours, fonts, grid and default size, so don't add colours unless you want a second accent
(`drAccentB`, `drAccentC`, `drAccentD`).

Wrap each chart in `figure` (report) with `\centering` and a `\caption{...}`; on slides, put one chart per
frame with the chart title as the frame title (no figure environment needed).

pgfplots doesn't understand CSV quoting. If a label has a quoted comma in it, the row splits into extra columns. If that breaks the build, leave that chart out and don't edit the CSV.

## line: `kind: "line"`, x is a date (YYYY-MM-DD)

```latex
\begin{tikzpicture}
\begin{axis}[date coordinates in=x, xticklabel={\pgfcalendarmonthshortname{\month}~\day}, xtick distance=7, ylabel={commits}, ymin=0]
\addplot table[col sep=comma, x=date, y=commits]{data/commits_per_day.csv};
\end{axis}
\end{tikzpicture}
```
- `xtick distance` is in days: use 1 for ≤ 10 days, 7 for ≤ 3 months, 30 above that.
- A second series from the same file (e.g. `y=added`) can be a separate chart. Don't mix commits and lines on one axis.
- If x is not a date (a number), drop `date coordinates in=x` and `xticklabel`.

## bar: `kind: "bar"`, x is a category

Short labels (≤ 8 categories, short words), vertical:
```latex
\begin{tikzpicture}\drsafecats
\begin{axis}[drbar, xtick=data, xticklabels from table={data/commit_types.csv}{type}, table/col sep=comma, ymin=0, enlarge x limits=0.08, nodes near coords, nodes near coords style={font=\scriptsize, drMuted}]
\addplot table[col sep=comma, x expr=\coordindex, y=count]{data/commit_types.csv};
\end{axis}
\end{tikzpicture}
```

Long labels (file paths, error messages: `top_files.csv`, `top_errors.csv`), horizontal:
```latex
\begin{tikzpicture}\drsafecats
\begin{axis}[drhbar, y dir=reverse, ytick=data, yticklabels from table={data/top_files.csv}{file}, table/col sep=comma, yticklabel style={font=\ttfamily\scriptsize}, xmin=0, height=7cm, enlarge y limits=0.06, nodes near coords, nodes near coords style={font=\scriptsize, drMuted}]
\addplot table[col sep=comma, y expr=\coordindex, x=changes]{data/top_files.csv};
\end{axis}
\end{tikzpicture}
```
- `\drsafecats` (from the theme) must come first inside the `tikzpicture`, so `_ # % & $` in labels from the CSV print instead of breaking the build.
- For errors use `\addplot+[drAccentC, fill=drAccentC]` to colour them as warnings.
- On slides use `height=5.5cm` and `font=\ttfamily\tiny` for the labels.

## pie: `kind: "pie"` (≤ 7 parts of a whole)

```latex
\drpie{data/commit_types.csv}{type}{count}
```
`\drpie[pgf-pie options]{csv}{label column}{value column}` comes from the theme and reads the CSV itself. It
already makes its own `tikzpicture`. Put it inside a `figure` with a caption. On slides use `\drpie[radius=1.6]{...}`.
Two pies side by side: `\drpie{a.csv}{..}{..}\hspace{2em}\drpie{b.csv}{..}{..}`.

## heatmap: `kind: "heatmap"` (`commit_hours.csv`, 24 rows hour,commits)

A strip of 24 squares, coloured by commits:
```latex
\begin{tikzpicture}
\begin{axis}[height=2.4cm, width=0.95\linewidth, ymajorgrids=false, axis y line=none, axis x line*=bottom, x axis line style={draw=none}, xtick={0,3,...,21}, xticklabel={\pgfmathprintnumber{\tick}:00}, ytick=\empty, xmin=-0.6, xmax=23.6, ymin=-0.5, ymax=0.5, colormap={dr}{color=(drGrid) color=(drAccent)}, point meta min=0]
\addplot[scatter, only marks, mark=square*, mark size=7.4pt, scatter src=explicit, scatter/use mapped color={draw=drBg, fill=mapped color}] table[col sep=comma, x=hour, y expr=0, meta=commits]{data/commit_hours.csv};
\end{axis}
\end{tikzpicture}
```
Caption it "Commits by hour of day (brighter = more)". On a 16:9 slide use `mark size=6pt`.

## hist: `kind: "hist"` (one numeric column)

```latex
\begin{tikzpicture}
\begin{axis}[ymin=0, ylabel={count}]
\addplot+[hist={bins=8}, fill=drAccentB, draw=drBg, fill opacity=0.9, mark=none] table[col sep=comma, y=added]{data/commits_per_day.csv};
\end{axis}
\end{tikzpicture}
```

## KPI row (text facts, not a chart)

Numbers from `facts.repo` / `facts.logs` may be written as text. Use up to 4 tiles:
```latex
\noindent\drkpi{214}{commits}\hfill\drkpi{2}{authors}\hfill\drkpi{+9,412}{lines added}\hfill\drkpi{33}{days}
```
Copy each value from facts.json exactly. Days = lastDate − firstDate + 1; skip that tile if you are unsure.
