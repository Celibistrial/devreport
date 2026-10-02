FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git unzip poppler-utils fontconfig ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# official prebuilt static tectonic for this arch (x86_64 or aarch64); the drop.sh installer asks for an aarch64 gnu build that doesn't exist
ARG TECTONIC=0.17.0
RUN curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC}/tectonic-${TECTONIC}-$(uname -m)-unknown-linux-musl.tar.gz" \
 | tar -xz -C /usr/local/bin && tectonic --version
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# warm tectonic's package cache (~/.cache/Tectonic) so the first real job is fast and works offline
RUN set -e; T=.claude/skills/devreport/themes; W=jobs/_warm; mkdir -p $W; cp -R $T/sample/. $W/; cd $W; \
 for t in metropolis moloch focus trigon madrid paper midnight; do printf '\\usepackage{../../%s/devreport-%s}\n' "$T" "$t" > theme.tex; tectonic main.tex; done; \
 printf '\\documentclass[11pt]{article}\n\\usepackage{../../%s/devreport-article}\n\\title{t}\\author{a}\\begin{document}\\maketitle\\begin{abstract}x\\end{abstract}\\section{A}x\\end{document}\n' "$T" > report.tex; tectonic report.tex; \
 cd /app && rm -rf jobs/_warm
ENV HOST=0.0.0.0 DEVREPORT_ENGINE=ai
EXPOSE 3000
CMD ["node", "server.js"]
