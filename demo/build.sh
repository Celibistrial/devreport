#!/bin/sh
# builds the static demo into demo/dist from the live index.html (see demo/demo.js)
set -e
cd "$(dirname "$0")/.."
rm -rf demo/dist && mkdir -p demo/dist
grep -c '^<script>$' index.html | grep -qx 1 || { echo 'expected exactly one bare <script> in index.html' >&2; exit 1; }
sed 's|^<script>$|<script src="/demo.js"></script>\n<script>|' index.html > demo/dist/index.html
cp -R .claude/skills/devreport/themes/previews demo/dist/previews
cp -R demo/assets demo/dist/assets
cp demo/demo.js demo/dist/demo.js
