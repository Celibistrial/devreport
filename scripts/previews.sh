#!/bin/sh
# Regenerate the theme previews from the sample deck/report in themes/sample/.
# Needs tectonic and pdftoppm (poppler). Run from anywhere: sh scripts/previews.sh [theme ...]
set -e
cd "$(dirname "$0")/.."
T=.claude/skills/devreport/themes
OUT=$T/previews
# a scratch job folder: the adapters load each other by ../../.claude/... paths, so it must sit two levels down like a real job
W=jobs/_previews
rm -rf "$W"; mkdir -p "$W"; cp -R "$T/sample/." "$W/"

render() { # render <pdf> <name> <width>: large JPEG per page + small PNG thumb of page 1
  pdftoppm -jpeg -jpegopt quality=80,optimize=y -scale-to-x "$3" -scale-to-y -1 "$1" "$OUT/$2"
  for f in "$OUT/$2"-0*.jpg; do [ -e "$f" ] && mv "$f" "$(echo "$f" | sed 's/-0*\([1-9]\)/-\1/')"; done
  pdftoppm -png -f 1 -l 1 -singlefile -scale-to-x 400 -scale-to-y -1 "$1" "$OUT/$2"
}

for t in ${@:-metropolis moloch focus trigon madrid paper midnight}; do
  printf '\\usepackage{../../%s/devreport-%s}\n' "$T" "$t" > "$W/theme.tex"
  (cd "$W" && tectonic -c minimal main.tex) && render "$W/main.pdf" "$t" 1000
  case $t in paper|midnight) (cd "$W" && tectonic -c minimal report.tex) && render "$W/report.pdf" "$t-report" 800 ;; esac
  echo "$t done"
done
rm -rf "$W"
ls -l "$OUT"
