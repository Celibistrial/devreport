# Chart snippets (tested with tectonic in every theme)

Every chart reads its numbers from a CSV listed in `facts.json` → `charts[]`. Use a chart only where it is evidence for the section around it; leaving charts out is fine. Swap the file name and
column names for the chart's `csv`, `x`, `y`. Never type a number into a chart. The theme already sets
colours, fonts, font sizes (ticks, labels, legends, the numbers from `nodes near coords`), grid and default size, so don't add colours unless you want a second accent
(`drAccentB`, `drAccentC`, `drAccentD`), and never set a `font=` size in a chart: the same snippet must look right in every theme.

Wrap each chart in `figure` (report) with `\centering` and a `\caption{...}`; on slides, put one chart per
frame with the chart title as the frame title (no figure environment needed).

pgfplots doesn't understand CSV quoting. If a label has a quoted comma in it, the row splits into extra columns. If that breaks the build, leave that chart out and don't edit the CSV.

## line: `kind: "line"`, x is a date (YYYY-MM-DD)

```latex
\begin{tikzpicture}
\begin{axis}[date coordinates in=x, xticklabel={\pgfcalendarmonthshortname{\month}~\day}, xtick distance=7, ylabel={signups}, ymin=0]
\addplot table[col sep=comma, x=date, y=signups]{data/table_x.csv};
\end{axis}
\end{tikzpicture}
```
- `xtick distance` is in days: use 1 for ≤ 10 days, 7 for ≤ 3 months, 30 above that.
- If x is not a date (a number), drop `date coordinates in=x` and `xticklabel`.

**Several series** (`y` is a list, e.g. `["train_loss", "val_loss"]` by `epoch`): one `\addplot` per column, x is a number. Type legend entries without `_ # % & $`:
```latex
\begin{tikzpicture}
\begin{axis}[xlabel={epoch}, ylabel={loss}, ymin=0, legend pos=north east]
\addplot+[mark=none] table[col sep=comma, x=epoch, y=train_loss]{data/table_results.csv}; \addlegendentry{train loss}
\addplot+[mark=none] table[col sep=comma, x=epoch, y=val_loss]{data/table_results.csv}; \addlegendentry{val loss}
\end{axis}
\end{tikzpicture}
```

**Timeline backdrop** (`commits_per_day.csv` only, never as a chart of its own): a short strip of spikes (one per active day, honest for gappy multi-year histories too) under the milestone list, no y label, no caption beyond "Activity over the project":
```latex
\begin{tikzpicture}
\begin{axis}[height=3cm, width=0.95\linewidth, date coordinates in=x, xticklabel={\pgfcalendarmonthshortname{\month}~\day}, xtick distance=7, ymin=0, ytick=\empty, ymajorgrids=false]
\addplot[ycomb, drAccent, line width=1.2pt, mark=none] table[col sep=comma, x=date, y=commits]{data/commits_per_day.csv};
\end{axis}
\end{tikzpicture}
```

## bar: `kind: "bar"`, x is a category

Short labels (≤ 8 categories, short words), vertical:
```latex
\begin{tikzpicture}\drsafecats
\begin{axis}[drbar, xtick=data, xticklabels from table={data/table_x.csv}{name}, table/col sep=comma, ymin=0, enlarge x limits=0.08, nodes near coords]
\addplot table[col sep=comma, x expr=\coordindex, y=value]{data/table_x.csv};
\end{axis}
\end{tikzpicture}
```

Long labels (error messages in `top_errors.csv`, long category names), horizontal:
```latex
\begin{tikzpicture}\drsafecats
\begin{axis}[drhbar, y dir=reverse, ytick=data, yticklabels from table={data/top_errors.csv}{error}, table/col sep=comma, xmin=0, height=7cm, enlarge y limits=0.06, nodes near coords]
\addplot table[col sep=comma, y expr=\coordindex, x=count]{data/top_errors.csv};
\end{axis}
\end{tikzpicture}
```
- `\drsafecats` (from the theme) must come first inside the `tikzpicture`, so `_ # % & $` in labels from the CSV print instead of breaking the build.
- For errors use `\addplot+[drAccentC, fill=drAccentC]` to colour them as warnings.
- On slides use `height=5.5cm`. `drhbar` already sets the labels in the theme's small monospace size; if they are too long to fit, show fewer rows or leave the chart out, never shrink them.

## pie: `kind: "pie"` (≤ 7 parts of a whole)

```latex
\drpie{data/table_x.csv}{name}{value}
```
`\drpie[pgf-pie options]{csv}{label column}{value column}` comes from the theme and reads the CSV itself. It
already makes its own `tikzpicture`. Put it inside a `figure` with a caption. On slides use `\drpie[radius=1.6]{...}`.
Two pies side by side: `\drpie{a.csv}{..}{..}\hspace{2em}\drpie{b.csv}{..}{..}`.

## hist: `kind: "hist"` (one numeric column)

```latex
\begin{tikzpicture}
\begin{axis}[ymin=0, ylabel={count}]
\addplot+[hist={bins=8}, fill=drAccentB, draw=drBg, fill opacity=0.9, mark=none] table[col sep=comma, y=value]{data/table_x.csv};
\end{axis}
\end{tikzpicture}
```

## table: a user `table_*.csv` as a booktabs table

For a small table (≤ 12 rows, ≤ 5 columns) where the exact numbers matter more than the shape:
```latex
\pgfplotstabletypeset[col sep=comma, string type, every head row/.style={before row=\toprule, after row=\midrule}, every last row/.style={after row=\bottomrule}]{data/table_x.csv}
```
`string type` prints every cell as it is in the CSV. If a cell has `_ & % #` in it, the build breaks: put `\drsafecats` just before the command, inside a group: `{\drsafecats\pgfplotstabletypeset[...]{...}}`.

## KPI row (only for real outcome numbers)

Only when facts hold an outcome number: users, error rate, latency, accuracy, tests passing (from logs, a user table or the answers, including the proudest-result answer). Commits, lines, files and days are never tiles. Copy each value exactly as the source writes it; never compute one. Up to 4 tiles:
```latex
\noindent\drkpi{<value as written>}{<what it measures>}\hfill\drkpi{...}{...}
```
