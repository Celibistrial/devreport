#!/usr/bin/env node
// PPT template extractor: <file.pptx> -> <outDir>/template.json + media/ + thumbnail.jpeg (see HANDOFF.md "PPT template import").
// Regex over the XML is enough here: theme/layout parts are machine-written and we only read a few attributes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_UNZIPPED = 200 * 1024 * 1024, MAX_MEDIA = 20, MAX_MEDIA_FILE = 10 * 1024 * 1024;
const COLORS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink'];
const CLRMAP = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }; // default master mapping
const FONT_DIRS = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts'),
  '/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts'), path.join(os.homedir(), '.fonts')];

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
const num = (s) => +String(s).replace(/\D.*$/, '') || 0;
const round = (n) => Math.round(n * 1000) / 1000;

// Same rules as server.js zips: size cap before extracting, no path escapes, no symlinks.
function unzipSafe(file, dir) {
  let listing;
  try { listing = sh('unzip', ['-l', file]); } catch { throw new Error('Not a .pptx: the file is not a zip archive'); }
  const total = +listing.trim().split('\n').pop().trim().split(/\s+/)[0];
  if (!Number.isFinite(total)) throw new Error('Not a .pptx: could not read the zip listing');
  if (total > MAX_UNZIPPED) throw new Error(`.pptx expands to ${(total / 1e6).toFixed(0)} MB (limit 200 MB)`);
  for (const n of sh('unzip', ['-Z1', file]).split('\n').filter(Boolean)) {
    const p = path.resolve(dir, n);
    if (path.isAbsolute(n) || !p.startsWith(dir + path.sep)) throw new Error(`.pptx entry escapes the folder: ${n}`);
  }
  if (sh('unzip', ['-Z', file]).split('\n').some((l) => /^l/.test(l))) throw new Error('.pptx contains symlinks');
  sh('unzip', ['-q', '-o', file, '-d', dir]);
  sh('find', [dir, '-type', 'l', '-delete']);
  if (!fs.existsSync(path.join(dir, 'ppt/presentation.xml'))) throw new Error('Not a .pptx: no ppt/presentation.xml inside');
}

// A colour element (<a:srgbClr val>, <a:sysClr lastClr>, <a:schemeClr val>) -> "RRGGBB" or null
function color(xml, scheme) {
  const hex = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(xml) || /<a:sysClr\b[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(xml);
  if (hex) return hex[1].toUpperCase();
  const s = /<a:schemeClr\s+val="(\w+)"/.exec(xml);
  return s ? scheme[CLRMAP[s[1]] || s[1]] || null : null;
}

function fontAvailable(name) {
  if (!name) return false;
  const want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return FONT_DIRS.some((d) => { try { return fs.readdirSync(d, { recursive: true }).some((f) => path.basename(String(f)).toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(want)); } catch { return false; } });
}

// Media referenced by a part's rels: rId -> "image1.png"
function rels(dir, part) {
  const out = {};
  const xml = read(dir, path.join(path.dirname(part), '_rels', path.basename(part) + '.rels'));
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1], target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) out[id] = target;
  }
  return out;
}

function background(dir, part, scheme) {
  const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(read(dir, part))?.[1];
  if (!bg) return null;
  const img = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(bg)?.[1];
  if (img) return { image: path.basename(rels(dir, part)[img] || '') || null };
  return { color: color(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/.exec(bg)?.[1] || /<p:bgRef[\s\S]*?<\/p:bgRef>/.exec(bg)?.[0] || '', scheme) };
}

// Placeholder boxes in a layout/master: {title|body|subtitle: {x,y,w,h} in EMU}
function boxes(xml) {
  const out = {};
  for (const m of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const ph = /<p:ph\b([^>]*)\/?>/.exec(m[1]);
    if (!ph) continue;
    const type = /type="(\w+)"/.exec(ph[1])?.[1] || 'body';
    const key = { title: 'title', ctrTitle: 'title', body: 'body', obj: 'body', subTitle: 'subtitle' }[type];
    const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(m[1]), ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(m[1]);
    if (key && off && ext && !out[key]) out[key] = { x: +off[1], y: +off[2], w: +ext[1], h: +ext[2] };
  }
  return out;
}

function extract(file, outDir) {
  outDir = path.resolve(outDir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devreport-pptx-'));
  try {
    unzipSafe(path.resolve(file), tmp);
    const t = { source: path.basename(file), slide: null, colors: {}, fonts: {}, background: null, layouts: {}, media: [], thumbnail: null };
    const safe = (fn) => { try { fn(); } catch { /* odd file: keep what we have */ } };
    fs.mkdirSync(outDir, { recursive: true });

    safe(() => {
      const sz = /<p:sldSz\b[^>]*>/.exec(read(tmp, 'ppt/presentation.xml'))?.[0] || '';
      const cx = num(/cx="(\d+)"/.exec(sz)?.[1]) || 12192000, cy = num(/cy="(\d+)"/.exec(sz)?.[1]) || 6858000;
      t.slide = { cx, cy, aspect: round(cx / cy), widthCm: round(cx / 360000), heightCm: round(cy / 360000) };
    });
    safe(() => {
      const theme = read(tmp, 'ppt/theme/theme1.xml');
      const scheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(theme)?.[1] || '';
      for (const c of COLORS) { const v = color(new RegExp(`<a:${c}>([\\s\\S]*?)</a:${c}>`).exec(scheme)?.[1] || '', {}); if (v) t.colors[c] = v; }
      for (const k of ['major', 'minor']) {
        const name = new RegExp(`<a:${k}Font>[\\s\\S]*?<a:latin\\s+typeface="([^"]*)"`).exec(theme)?.[1] || null;
        t.fonts[k] = { name, installed: fontAvailable(name) };
      }
    });

    // first title layout and first content layout, falling back to the master's placeholder boxes
    const layoutFiles = (() => { try { return fs.readdirSync(path.join(tmp, 'ppt/slideLayouts')).filter((f) => /^slideLayout\d+\.xml$/.test(f)).sort((a, b) => num(a.slice(11)) - num(b.slice(11))); } catch { return []; } })();
    const master = 'ppt/slideMasters/slideMaster1.xml';
    const frac = (r) => r && t.slide && { x: round(r.x / t.slide.cx), y: round(r.y / t.slide.cy), w: round(r.w / t.slide.cx), h: round(r.h / t.slide.cy) };
    safe(() => {
      const mBoxes = boxes(read(tmp, master));
      t.background = background(tmp, master, t.colors);
      const pick = (types) => layoutFiles.find((f) => types.includes(/<p:sldLayout\b[^>]*\btype="(\w+)"/.exec(read(tmp, 'ppt/slideLayouts/' + f))?.[1]));
      for (const [key, types] of [['title', ['title']], ['content', ['obj', 'tx', 'twoObj', 'titleOnly']]]) {
        const f = pick(types);
        const own = f ? boxes(read(tmp, 'ppt/slideLayouts/' + f)) : {};
        const b = { ...mBoxes, ...own };
        t.layouts[key] = {
          file: f || null, background: (f && background(tmp, 'ppt/slideLayouts/' + f, t.colors)) || t.background,
          title: frac(b.title), [key === 'title' ? 'subtitle' : 'body']: frac(key === 'title' ? (own.subtitle || b.body) : b.body),
        };
      }
    });

    // media: png/jpg only (tectonic), 16-bit PNG -> 8-bit JPEG like collect.js; note which master/layout uses each
    safe(() => {
      const usedBy = {}, at = {}; // at: where a master/layout places the picture (a logo, usually)
      for (const part of [master, ...layoutFiles.map((f) => 'ppt/slideLayouts/' + f)]) {
        const r = rels(tmp, part), name = path.basename(part, '.xml');
        for (const target of Object.values(r)) (usedBy[path.basename(target)] ||= []).push(name);
        for (const m of read(tmp, part).matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/g)) {
          const img = path.basename(r[/r:embed="([^"]+)"/.exec(m[1])?.[1]] || ''), box = boxes(`<p:sp><p:ph/>${m[1]}</p:sp>`).body;
          if (img && box && !at[img]) at[img] = { in: name, ...frac(box) };
        }
      }
      const mediaDir = path.join(tmp, 'ppt/media');
      const files = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [];
      for (const f of files.slice(0, MAX_MEDIA)) safe(() => {
        const src = path.join(mediaDir, f), buf = fs.readFileSync(src);
        if (!fs.statSync(src).isFile() || buf.length > MAX_MEDIA_FILE) return;
        fs.mkdirSync(path.join(outDir, 'media'), { recursive: true });
        let out = 'media/' + f.replace(/[^\w.-]/g, '_');
        const isPng = buf.subarray(1, 4).toString() === 'PNG';
        if (isPng && buf[24] === 16) try { out = out.replace(/\.png$/i, '.jpg'); execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', path.join(outDir, out)], { stdio: 'ignore' }); } catch { out = 'media/' + f; }
        if (!fs.existsSync(path.join(outDir, out))) fs.copyFileSync(src, path.join(outDir, out));
        const size = isPng ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : jpegSize(buf);
        t.media.push({ file: out, ...size, usedBy: usedBy[f] || [], ...(at[f] && { at: at[f] }) });
      });
    });
    safe(() => {
      const th = path.join(tmp, 'docProps/thumbnail.jpeg');
      if (fs.statSync(th).isFile()) { fs.copyFileSync(th, path.join(outDir, 'thumbnail.jpeg')); t.thumbnail = 'thumbnail.jpeg'; }
    });

    fs.writeFileSync(path.join(outDir, 'template.json'), JSON.stringify(t, null, 2) + '\n');
    return t;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return {};
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return {};
}

if (require.main === module) {
  const [file, outDir] = process.argv.slice(2);
  if (!file || !outDir) { console.error('usage: node pptx.js <file.pptx> <outDir>'); process.exit(2); }
  try { const t = extract(file, outDir); console.log(`template: ${Object.keys(t.colors).length} colors, fonts ${t.fonts.major?.name}/${t.fonts.minor?.name}, ${t.media.length} media`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { extract };
