'use strict';
// LocalShare — send messages and files to any device on your LAN through a browser.
// One computer hosts; everyone else joins with a browser. Zero dependencies.
// Run with `node server.js` or use the packaged LocalShare.exe.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');

let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { /* not packaged */ }

// The host answers "LOCALSHARE?" on this UDP port, so `pull` can find it without an address.
const DISCOVERY_PORT = 41780;

// `node server.js pull …` (or `LocalShare.exe pull …`) copies a shared folder onto
// this computer instead of starting a server. See runPull at the bottom.
if (process.argv[2] === 'pull') {
  runPull(process.argv.slice(3)).then(
    () => process.exit(0),
    (e) => { console.error('\n  ' + e.message + '\n'); process.exit(1); });
  return; // CommonJS allows a top-level return: nothing below runs
}

const BASE_DIR = sea ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(BASE_DIR, 'LocalShare Files'); // one sub-folder per room
const CHAT_DIR = path.join(DATA_DIR, '.chat');            // <room>.jsonl message history
const INDEX_HTML = sea
  ? sea.getAsset('index.html', 'utf8')
  : fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const argv = process.argv;
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const DEFAULT_PORT = 8971;
const PORT_GIVEN = argVal('--port') || process.env.PORT;
const NO_OPEN = argv.includes('--no-open');

fs.mkdirSync(CHAT_DIR, { recursive: true });
if (process.platform === 'win32') exec(`attrib +h "${CHAT_DIR}"`, () => {});

const DEFAULT_ROOM = 'general';
const PAGE = 200; // messages sent when opening a room; older ones load on demand

// ---------- rooms ----------
// Room names are easy to type: lowercase letters, digits and dashes ("work", "family-pics").
const RESERVED = /^(api|events|files|index|con|prn|aux|nul|com\d|lpt\d)$/;
function cleanRoom(n) {
  const s = String(n || '').toLowerCase().trim()
    .replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '');
  return s && !RESERVED.test(s) ? s : '';
}

const rooms = new Map(); // name -> { name, events, file, dir }

function getRoom(name) {
  let r = rooms.get(name);
  if (r) return r;
  r = { name, events: [], file: path.join(CHAT_DIR, name + '.jsonl'), dir: path.join(DATA_DIR, name) };
  try {
    for (const line of fs.readFileSync(r.file, 'utf8').split('\n')) {
      if (!line) continue;
      try { r.events.push(JSON.parse(line)); } catch { /* skip damaged line */ }
    }
  } catch { /* new room */ }
  fs.mkdirSync(r.dir, { recursive: true });
  rooms.set(name, r);
  return r;
}

getRoom(DEFAULT_ROOM);
for (const f of fs.readdirSync(CHAT_DIR)) {
  const n = f.endsWith('.jsonl') && cleanRoom(f.slice(0, -6));
  if (n === f.slice(0, -6)) getRoom(n);
}
for (const d of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
  if (d.isDirectory() && cleanRoom(d.name) === d.name) getRoom(d.name);
}

// ---------- live clients ----------
const clients = new Map(); // res -> { client, room }

function sse(res, ev) { res.write('data: ' + JSON.stringify(ev) + '\n\n'); }

function roomsSummary() {
  const online = new Map();
  for (const c of clients.values()) {
    if (!online.has(c.room)) online.set(c.room, new Set());
    online.get(c.room).add(c.client);
  }
  const list = [...rooms.values()].map((r) => ({
    name: r.name,
    count: r.events.length,
    online: online.has(r.name) ? online.get(r.name).size : 0,
  }));
  list.sort((a, b) => (a.name === DEFAULT_ROOM ? -1 : b.name === DEFAULT_ROOM ? 1 : a.name.localeCompare(b.name)));
  const everyone = new Set([...clients.values()].map((c) => c.client)).size;
  return { type: 'rooms', rooms: list, online: everyone };
}

function broadcastRooms() {
  const ev = roomsSummary();
  for (const res of clients.keys()) sse(res, ev);
}

function addEvent(r, ev) {
  const last = r.events[r.events.length - 1];
  ev.id = last ? last.id + 1 : 1;
  ev.time = Date.now();
  r.events.push(ev);
  fs.appendFileSync(r.file, JSON.stringify(ev) + '\n');
  for (const [res, c] of clients) if (c.room === r.name) sse(res, ev);
  broadcastRooms();
  return ev;
}

setInterval(() => { for (const res of clients.keys()) res.write(': ping\n\n'); }, 20000).unref();

// ---------- helpers ----------
function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json');

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Anonymous';
}

function sanitizeFilename(name) {
  name = path.basename(String(name || '').replace(/\\/g, '/'));
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!name) name = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name;
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

function lanAddresses() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ ip: a.address, ifname, mac: a.mac || '' });
    }
  }
  // MAC prefixes of common virtual adapters: VirtualBox, VMware, Hyper-V, Parallels, Docker
  const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|00:1c:42|02:42)/i;
  const score = (a) => {
    if (a.ip.startsWith('169.254.')) return 9;
    if (VIRTUAL_MAC.test(a.mac)) return 5;
    if (/vEthernet|VirtualBox|VMware|docker|br-|veth|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|Bluetooth/i.test(a.ifname)) return 5;
    if (a.ip.startsWith('192.168.')) return 0;
    if (a.ip.startsWith('10.')) return 1;
    return 2;
  };
  return out.sort((a, b) => score(a) - score(b)).map((a) => a.ip);
}

// ---------- passcode ----------
// Optional. Set from the host's browser (http://localhost) or with --passcode.
// Stored as a salted scrypt hash in .chat/config.json; devices that enter it
// get a long-lived cookie. The host computer itself never needs it.
const CONFIG_FILE = path.join(CHAT_DIR, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { /* first run */ }
if (!config.secret) config.secret = crypto.randomBytes(32).toString('hex');
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
saveConfig();

const hashPass = (p, salt) => crypto.scryptSync(String(p), salt, 32).toString('hex');
function setPasscode(p) {
  if (p) { config.salt = crypto.randomBytes(16).toString('hex'); config.passHash = hashPass(p, config.salt); }
  else { delete config.salt; delete config.passHash; }
  saveConfig();
}
// Changes whenever the passcode changes, so old cookies stop working.
const authToken = () => crypto.createHmac('sha256', config.secret).update(config.passHash || '').digest('hex');
const cookieName = () => 'ls_auth_' + PORT;
if (argVal('--passcode') !== undefined) setPasscode(argVal('--passcode')); // "--passcode ''" removes it

// The host is this computer, opened as localhost. Checking the Host header too
// stops a website that points its own domain at 127.0.0.1 (DNS rebinding) from
// getting host rights.
function isHost(req) {
  const a = req.socket.remoteAddress || '';
  const local = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const name = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return local && (name === 'localhost' || name === '127.0.0.1' || name === '[::1]');
}
// Browsers send Origin with every POST. Refuse ones made by other websites, so a
// page the host visits can't post messages or change the passcode behind their back.
function crossSite(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host !== String(req.headers.host || ''); } catch { return true; }
}
function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authed(req) {
  return !config.passHash || isHost(req) || sameText(cookie(req, cookieName()), authToken());
}

// Slow down guessing: after 5 wrong tries from one address, wait 30 s, then 1 min, 2 min… up to 15 min.
const attempts = new Map(); // ip -> { fails, until }
async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || '';
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  if (a.until > Date.now()) return json(res, 429, { error: 'Too many tries', wait: Math.ceil((a.until - Date.now()) / 1000) });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad request' }); }
  if (!config.passHash) return json(res, 200, { ok: true });
  if (sameText(hashPass(body.passcode || '', config.salt), config.passHash)) {
    attempts.delete(ip);
    res.setHeader('Set-Cookie', `${cookieName()}=${authToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return json(res, 200, { ok: true });
  }
  a.fails++;
  if (a.fails >= 5) a.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (a.fails - 5)) * 1000;
  attempts.set(ip, a);
  console.log(`  Wrong passcode from ${ip.replace(/^::ffff:/, '')}`);
  json(res, 401, { error: 'Wrong passcode', wait: a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0 });
}

async function handleSetPasscode(req, res) {
  if (!isHost(req)) return json(res, 403, { error: 'Only the host computer can change the passcode' });
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad request' }); }
  const p = body.passcode == null ? '' : String(body.passcode);
  if (p && p.length < 4) return json(res, 400, { error: 'Use at least 4 characters' });
  setPasscode(p);
  attempts.clear();
  console.log(p ? '  Passcode set. Other devices must enter it to join.' : '  Passcode removed. Anyone on the network can join.');
  // Disconnect devices that no longer have a valid passcode cookie.
  for (const [r, c] of clients) if (!authed(c.req)) { clients.delete(r); r.end(); }
  for (const r of clients.keys()) sse(r, { type: 'security', passcode: !!config.passHash });
  broadcastRooms();
  json(res, 200, { passcode: !!config.passHash });
}

// ---------- handlers ----------
function handleEvents(req, res, url) {
  const r = getRoom(cleanRoom(url.searchParams.get('room')) || DEFAULT_ROOM);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  sse(res, { type: 'history', room: r.name, events: r.events.slice(-PAGE), hasMore: r.events.length > PAGE });
  clients.set(res, { client: String(url.searchParams.get('id') || Math.random()).slice(0, 32), room: r.name, req });
  broadcastRooms();
  req.on('close', () => { clients.delete(res); broadcastRooms(); });
}

function handleHistory(res, url) {
  const r = rooms.get(cleanRoom(url.searchParams.get('room')));
  if (!r) return json(res, 404, { error: 'No such room' });
  const before = Number(url.searchParams.get('before')) || Infinity;
  let end = r.events.findIndex((e) => e.id >= before);
  if (end < 0) end = r.events.length;
  const start = Math.max(0, end - PAGE);
  json(res, 200, { events: r.events.slice(start, end), hasMore: start > 0 });
}

async function handleMessage(req, res) {
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad request' }); }
  const text = String(body.text || '');
  if (!text.trim()) return json(res, 400, { error: 'Empty message' });
  const r = getRoom(cleanRoom(body.room) || DEFAULT_ROOM);
  const ev = addEvent(r, { type: 'msg', from: cleanName(body.from), client: String(body.client || '').slice(0, 32), text });
  json(res, 200, { id: ev.id });
}

const hdr = (req, h) => { try { return decodeURIComponent(req.headers[h] || ''); } catch { return ''; } };

// "Photos/2024/a.jpg" -> ['Photos', '2024', 'a.jpg'], each part made safe; null if nothing usable.
function cleanRelPath(p) {
  const segs = String(p || '').replace(/\\/g, '/').split('/')
    .filter((s) => s && s !== '.' && s !== '..').map(sanitizeFilename);
  return segs.length && segs.length <= 64 ? segs : null;
}

// Every file under dir, as [{ path: 'sub/a.txt', size, mtime }], sorted by path.
async function walk(dir, prefix = '', out = []) {
  const ents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, prefix + e.name + '/', out);
    else if (e.isFile()) {
      try { const st = await fs.promises.stat(full); out.push({ path: prefix + e.name, size: st.size, mtime: st.mtimeMs }); } catch { /* vanished */ }
    }
  }
  if (!prefix) out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// Plain files go straight into the room and appear in the chat at once.
// Folder files carry X-Folder (from /api/folder/start) and X-Path, and appear
// together as one message when the sender calls /api/folder/done.
function handleUpload(req, res) {
  const r = getRoom(cleanRoom(hdr(req, 'x-room')) || DEFAULT_ROOM);
  const from = hdr(req, 'x-from');
  const client = String(req.headers['x-client'] || '').slice(0, 32);
  const folder = hdr(req, 'x-folder');
  let dest, name;
  if (folder) {
    const fdir = path.join(r.dir, sanitizeFilename(folder));
    const rel = cleanRelPath(hdr(req, 'x-path'));
    if (!rel || !fs.existsSync(fdir)) return json(res, 400, { error: 'Bad folder upload' });
    const dir = path.join(fdir, ...rel.slice(0, -1));
    fs.mkdirSync(dir, { recursive: true });
    // X-Replace: a resend of a file that a failed bundle may have half-written
    name = req.headers['x-replace'] ? rel[rel.length - 1] : uniqueName(dir, rel[rel.length - 1]);
    dest = path.join(dir, name);
    if (req.headers['x-replace']) {
      try { if (fs.statSync(dest).isFile()) fs.unlinkSync(dest); } catch { /* not there */ }
    }
  } else {
    name = uniqueName(r.dir, sanitizeFilename(hdr(req, 'x-filename') || 'file'));
    dest = path.join(r.dir, name);
  }

  pipeline(req, fs.createWriteStream(dest, { flags: 'wx' }), (err) => {
    if (err) {
      fs.unlink(dest, () => {});
      if (!res.headersSent) json(res, 500, { error: 'Upload failed' });
      return;
    }
    if (folder) return json(res, 200, { ok: true });
    fs.stat(dest, (e, st) => {
      const ev = addEvent(r, { type: 'file', from: cleanName(from), client, name, size: e ? 0 : st.size });
      console.log(`  [${r.name}] ${ev.from} shared "${name}" (${ev.size} bytes)`);
      json(res, 200, { id: ev.id });
    });
  });
}

// Reads exact byte counts from a request stream.
function byteReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  async function fill(n) {
    while (buf.length < n) {
      const { value, done } = await it.next();
      if (done) return false;
      buf = buf.length ? Buffer.concat([buf, value]) : value;
    }
    return true;
  }
  return {
    async take(n) {
      if (!(await fill(n))) throw new Error('Upload ended early');
      const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
    },
    async *chunks(n) { // the next n bytes, as they arrive
      while (n > 0) {
        if (!buf.length && !(await fill(1))) throw new Error('Upload ended early');
        const c = buf.subarray(0, Math.min(n, buf.length));
        buf = buf.subarray(c.length); n -= c.length;
        yield c;
      }
    },
    async atEnd() { return !(await fill(1)); },
  };
}

// Many small files of a shared folder in one request. The body is a sequence of
//   uint16 LE path length | UTF-8 path | uint64 LE size | file bytes
// and each file is written to disk as it streams in.
async function handleUploadBatch(req, res) {
  const r = getRoom(cleanRoom(hdr(req, 'x-room')) || DEFAULT_ROOM);
  const fdir = path.join(r.dir, sanitizeFilename(hdr(req, 'x-folder')));
  if (!hdr(req, 'x-folder') || !fs.existsSync(fdir)) { req.resume(); return json(res, 400, { error: 'Bad folder upload' }); }
  const rd = byteReader(req);
  let count = 0, dest = null, ws = null;
  try {
    while (!(await rd.atEnd())) {
      const nameLen = (await rd.take(2)).readUInt16LE(0);
      const rel = cleanRelPath((await rd.take(nameLen)).toString('utf8'));
      const size = Number((await rd.take(8)).readBigUInt64LE(0));
      if (!rel) { for await (const c of rd.chunks(size)) void c; continue; } // skip unusable names
      const dir = path.join(fdir, ...rel.slice(0, -1));
      await fs.promises.mkdir(dir, { recursive: true });
      dest = path.join(dir, uniqueName(dir, rel[rel.length - 1]));
      ws = fs.createWriteStream(dest, { flags: 'wx' });
      const failed = new Promise((_, rej) => ws.once('error', rej));
      failed.catch(() => {});
      for await (const c of rd.chunks(size)) {
        if (!ws.write(c)) await Promise.race([new Promise((ok) => ws.once('drain', ok)), failed]);
      }
      await Promise.race([new Promise((ok) => ws.end(ok)), failed]);
      ws = null; dest = null; count++;
    }
    json(res, 200, { count });
  } catch (e) {
    if (ws) { ws.destroy(); fs.unlink(dest, () => {}); }
    req.resume();
    if (!res.headersSent) json(res, 500, { error: 'Upload failed', count });
  }
}

async function handleFolderStart(req, res) {
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad request' }); }
  const r = getRoom(cleanRoom(body.room) || DEFAULT_ROOM);
  const folder = uniqueName(r.dir, sanitizeFilename(body.name || 'folder'));
  fs.mkdirSync(path.join(r.dir, folder));
  json(res, 200, { folder });
}

async function handleFolderDone(req, res) {
  let body;
  try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad request' }); }
  const r = rooms.get(cleanRoom(body.room));
  const folder = sanitizeFilename(body.folder);
  const fdir = r && path.join(r.dir, folder);
  if (!fdir || !fs.existsSync(fdir)) return json(res, 404, { error: 'No such folder' });
  const files = await walk(fdir);
  if (!files.length) {
    fs.rm(fdir, { recursive: true, force: true }, () => {});
    return json(res, 400, { error: 'Folder is empty' });
  }
  const size = files.reduce((s, f) => s + f.size, 0);
  const ev = { type: 'folder', from: cleanName(body.from), client: String(body.client || '').slice(0, 32), name: folder, count: files.length, size };
  // What the sender left out (node_modules, .git, things in .gitignore), shown on the card.
  const skipped = Array.isArray(body.skipped) ? body.skipped.map((s) => String(s).slice(0, 120)).filter(Boolean).slice(0, 30) : [];
  if (skipped.length) {
    ev.skipped = skipped;
    ev.skippedTotal = Math.min(Math.max(skipped.length, Math.floor(Number(body.skippedTotal)) || 0), 1e6);
  }
  addEvent(r, ev);
  console.log(`  [${r.name}] ${ev.from} shared folder "${folder}" (${files.length} files, ${size} bytes)`);
  json(res, 200, { id: ev.id });
}

async function handleListFiles(res, url) {
  const r = rooms.get(cleanRoom(url.searchParams.get('room')));
  if (!r) return json(res, 200, []);
  // ?folder=<name>: every file inside that shared folder
  if (url.searchParams.has('folder')) {
    const fdir = path.join(r.dir, sanitizeFilename(url.searchParams.get('folder')));
    return json(res, 200, await walk(fdir));
  }
  const ents = await fs.promises.readdir(r.dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const e of ents) {
    const full = path.join(r.dir, e.name);
    try {
      if (e.isFile()) {
        const st = await fs.promises.stat(full);
        files.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
      } else if (e.isDirectory()) {
        const st = await fs.promises.stat(full);
        const inner = await walk(full);
        files.push({ name: e.name, folder: true, count: inner.length, size: inner.reduce((s, f) => s + f.size, 0), mtime: st.mtimeMs });
      }
    } catch { /* vanished */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  json(res, 200, files);
}

// ---------- zip (store only, streamed, Zip64 when needed) ----------
function dosDateTime(ms) {
  const d = new Date(ms);
  const y = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function sendZip(req, res, dir, zipName) {
  const files = await walk(dir);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(zipName + '.zip'),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  let offset = 0, closed = false;
  res.on('close', () => { closed = true; });
  const out = async (buf) => {
    offset += buf.length;
    if (!res.write(buf)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
  };
  const MAX32 = 0xffffffff;
  const central = [];
  try {
    for (const f of files) {
      if (closed) return;
      const name = Buffer.from(zipName + '/' + f.path, 'utf8');
      const { time, date } = dosDateTime(f.mtime);
      const big = f.size >= MAX32 - 1024 * 1024; // margin in case the file grows while being read
      const start = offset;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(big ? 45 : 20, 4);
      lh.writeUInt16LE(0x0808, 6); // sizes in data descriptor, UTF-8 names
      lh.writeUInt16LE(0, 8);      // stored
      lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(0, 14);
      lh.writeUInt32LE(big ? MAX32 : 0, 18); lh.writeUInt32LE(big ? MAX32 : 0, 22);
      lh.writeUInt16LE(name.length, 26);
      let extra = Buffer.alloc(0);
      if (big) { extra = Buffer.alloc(20); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2); }
      lh.writeUInt16LE(extra.length, 28);
      await out(Buffer.concat([lh, name, extra]));

      let crc = 0, size = 0;
      for await (const chunk of fs.createReadStream(path.join(dir, f.path))) {
        if (closed) return;
        crc = zlib.crc32(chunk, crc); size += chunk.length;
        await out(chunk);
      }
      let dd;
      if (big) {
        dd = Buffer.alloc(24); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4);
        dd.writeBigUInt64LE(BigInt(size), 8); dd.writeBigUInt64LE(BigInt(size), 16);
      } else {
        dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4);
        dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12);
      }
      await out(dd);
      central.push({ name, time, date, crc, size, start, big });
    }

    const cdStart = offset;
    for (const c of central) {
      const z = [];
      if (c.size >= MAX32 || c.big) z.push(BigInt(c.size), BigInt(c.size));
      if (c.start >= MAX32) z.push(BigInt(c.start));
      let extra = Buffer.alloc(0);
      if (z.length) {
        extra = Buffer.alloc(4 + z.length * 8); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(z.length * 8, 2);
        z.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
      }
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(45, 4); ch.writeUInt16LE(z.length ? 45 : 20, 6);
      ch.writeUInt16LE(0x0808, 8); ch.writeUInt16LE(0, 10);
      ch.writeUInt16LE(c.time, 12); ch.writeUInt16LE(c.date, 14);
      ch.writeUInt32LE(c.crc, 16);
      const sz32 = c.size >= MAX32 || c.big ? MAX32 : c.size;
      ch.writeUInt32LE(sz32, 20); ch.writeUInt32LE(sz32, 24);
      ch.writeUInt16LE(c.name.length, 28); ch.writeUInt16LE(extra.length, 30);
      ch.writeUInt32LE(c.start >= MAX32 ? MAX32 : c.start, 42);
      await out(Buffer.concat([ch, c.name, extra]));
    }
    const cdSize = offset - cdStart;
    const n = central.length;
    if (n >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
      const z64At = offset;
      const r64 = Buffer.alloc(56);
      r64.writeUInt32LE(0x06064b50, 0); r64.writeBigUInt64LE(44n, 4);
      r64.writeUInt16LE(45, 12); r64.writeUInt16LE(45, 14);
      r64.writeBigUInt64LE(BigInt(n), 24); r64.writeBigUInt64LE(BigInt(n), 32);
      r64.writeBigUInt64LE(BigInt(cdSize), 40); r64.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(z64At), 8); loc.writeUInt32LE(1, 16);
      await out(Buffer.concat([r64, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(n, 0xffff), 8); end.writeUInt16LE(Math.min(n, 0xffff), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12); end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    await out(end);
    res.end();
  } catch (e) {
    console.error(e);
    res.destroy();
  }
}

function handleDownload(req, res, url) {
  // /files/<room>/<name>[/<sub>/<path>] — a file, or a shared folder (sent as .zip)
  const parts = url.pathname.slice('/files/'.length).split('/');
  if (parts.length < 2 || parts.length > 66) return send(res, 404, 'Not found', 'text/plain');
  let segs;
  try { segs = parts.map(decodeURIComponent); } catch { return send(res, 400, 'Bad name', 'text/plain'); }
  const room = segs.shift();
  if (!room || cleanRoom(room) !== room) return send(res, 404, 'Not found', 'text/plain');
  if (segs.some((s) => !s || s !== path.basename(s) || s === '.' || s === '..' || /[\u0000-\u001f]/.test(s))) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  const name = segs[segs.length - 1];
  const fp = path.join(DATA_DIR, room, ...segs);

  fs.stat(fp, (err, st) => {
    if (!err && st.isDirectory()) return sendZip(req, res, fp, name);
    if (err || !st.isFile()) return send(res, 404, 'File not found', 'text/plain');
    const mime = MIME[path.extname(name).toLowerCase()];
    const inline = url.searchParams.has('view') && mime;
    const headers = {
      'Content-Type': inline ? mime : 'application/octet-stream',
      'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name),
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    let start = 0, end = st.size - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && st.size > 0 && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, st.size - parseInt(m[2], 10));
      else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10)); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    pipeline(fs.createReadStream(fp, { start, end }), res, () => {});
  });
}

// ---------- server ----------
let PORT = DEFAULT_PORT;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    if (m === 'POST' && crossSite(req)) { req.resume(); return json(res, 403, { error: 'Cross-site request refused' }); }
    // Open to everyone: the page itself, the session check and the login.
    if (m === 'GET' && p === '/api/session') {
      return json(res, 200, { locked: !authed(req), host: isHost(req), passcode: !!config.passHash });
    }
    if (m === 'POST' && p === '/api/login') return await handleLogin(req, res);
    if (p === '/events' || p.startsWith('/api/') || p.startsWith('/files/')) {
      if (!authed(req)) { req.resume(); return json(res, 401, { error: 'Passcode required' }); }
    }
    if (m === 'POST' && p === '/api/passcode') return await handleSetPasscode(req, res);
    if (m === 'GET' && p === '/events') return handleEvents(req, res, url);
    if (m === 'GET' && p === '/api/history') return handleHistory(res, url);
    if (m === 'POST' && p === '/api/message') return await handleMessage(req, res);
    if (m === 'POST' && p === '/api/upload') return handleUpload(req, res);
    if (m === 'POST' && p === '/api/upload-batch') return await handleUploadBatch(req, res);
    if (m === 'POST' && p === '/api/folder/start') return await handleFolderStart(req, res);
    if (m === 'POST' && p === '/api/folder/done') return await handleFolderDone(req, res);
    if (m === 'GET' && p === '/api/files') return await handleListFiles(res, url);
    if (m === 'GET' && p === '/api/info') return json(res, 200, { urls: lanAddresses().map((ip) => `http://${ip}:${PORT}`) });
    if ((m === 'GET' || m === 'HEAD') && p.startsWith('/files/')) return handleDownload(req, res, url);
    // The page itself: "/" or "/<room>" (e.g. /work)
    if (m === 'GET' && (p === '/' || p === '/index.html' || /^\/[^/]+\/?$/.test(p))) {
      return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error', 'text/plain');
  }
});
server.requestTimeout = 0; // allow very large uploads and messages
server.headersTimeout = 60000;

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function onReady() {
  const urls = lanAddresses().map((ip) => `http://${ip}:${PORT}`);
  console.log('');
  console.log('  ==============================================');
  console.log('   LocalShare is running');
  console.log('  ==============================================');
  console.log('');
  console.log('  Open on this computer:  http://localhost:' + PORT);
  if (urls.length) {
    console.log('  Open on other devices:  ' + urls[0]);
    for (const u of urls.slice(1)) console.log('                          ' + u);
    console.log('');
    console.log('  Go straight to a room by adding its name, e.g. ' + urls[0] + '/work');
  } else {
    console.log('  (No network connection found — only this computer can connect.)');
  }
  console.log('');
  console.log(config.passHash
    ? '  Passcode: ON. Other devices must enter it to join.'
    : '  Passcode: OFF. Anyone on this network can join. Set one from the lock icon on this computer.');
  console.log('');
  console.log('  Files and chat history are saved in:');
  console.log('    ' + DATA_DIR);
  console.log('');
  console.log('  Close this window (or press Ctrl+C) to stop.');
  console.log('');
  if (!NO_OPEN) openBrowser('http://localhost:' + PORT);
}

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error('Could not start server: ' + err.message);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    server.removeAllListeners('error');
    server.on('error', (e) => console.error(e));
    PORT = port;
    onReady();
  });
}

// Answer pull's "LOCALSHARE?" broadcast with our port. reuseAddr keeps a second copy of
// LocalShare from failing to bind (it may not get the broadcasts, but its address still works).
function startDiscovery() {
  const sock = require('node:dgram').createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString() !== 'LOCALSHARE?') return;
    sock.send(JSON.stringify({ localshare: 1, port: PORT, name: os.hostname() }), rinfo.port, rinfo.address);
  });
  sock.on('error', () => sock.close()); // discovery is optional; the address always works
  sock.bind(DISCOVERY_PORT);
}

// Without --port, ask which port to use when started in a console (Enter keeps the default).
function askPort() {
  const valid = (n) => Number.isInteger(n) && n > 0 && n < 65536;
  if (PORT_GIVEN) {
    const n = parseInt(PORT_GIVEN, 10);
    return Promise.resolve(valid(n) ? n : DEFAULT_PORT);
  }
  if (!process.stdin.isTTY) return Promise.resolve(DEFAULT_PORT);
  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const ask = () => rl.question(`
  Port to use [${DEFAULT_PORT}]: `, (a) => {
      a = a.trim();
      if (!a) { rl.close(); return resolve(DEFAULT_PORT); }
      const n = Number(a);
      if (valid(n)) { rl.close(); return resolve(n); }
      console.log('  Enter a number from 1 to 65535, or press Enter for ' + DEFAULT_PORT + '.');
      ask();
    });
    ask();
  });
}

process.on('uncaughtException', (e) => console.error(e));
askPort().then((port) => {
  listen(port, 20);
  startDiscovery();
});

// ---------- pull: copy a shared folder onto this computer ----------
// node server.js pull <room | http://host:port/room> <folder> [destination] [--passcode X]
// Downloads every file of the newest folder called <folder> (or "<folder> (2)" etc.) in
// that room. Files whose size and time match the last pull are skipped; changed ones
// are replaced. Nothing else in the destination is touched or deleted.
async function runPull(args) {
  let passcode;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--passcode') passcode = args[++i] ?? '';
    else pos.push(args[i]);
  }
  const [where, folderName, destArg] = pos;
  if (!where || !folderName) {
    throw new Error([
      'Usage:  pull <room> <folder> [destination] [--passcode X]',
      '        pull http://192.168.0.210:8080/<room> <folder> [destination]',
      '',
      '  e.g.  node server.js pull work my-project D:\\code\\my-project',
    ].join('\n  '));
  }
  let base, room;
  if (/^https?:\/\//i.test(where)) {
    const u = new URL(where);
    base = u.origin;
    room = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, '')) || 'general';
  } else {
    room = where;
    base = await discoverHost();
  }
  room = room.toLowerCase();
  const dest = path.resolve(destArg || folderName);

  // Sign in when the host has a passcode.
  let cookieHeader = '';
  const session = await (await fetchOk(base + '/api/session')).json();
  if (session.locked) {
    if (passcode === undefined) passcode = await askLine('  Passcode: ');
    const r = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error(`Too many wrong passcodes. Try again in ${body.wait} seconds.`);
    if (!r.ok) throw new Error('Wrong passcode.');
    cookieHeader = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const get = (p) => fetchOk(base + p, { headers: { Cookie: cookieHeader } });

  // The newest folder with that name: re-sending "my-project" makes "my-project (1)", "(2)"…
  const entries = await (await get('/api/files?room=' + encodeURIComponent(room))).json();
  const esc = folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const same = new RegExp('^' + esc + '( \\(\\d+\\))?$', 'i');
  const pick = entries.filter((e) => e.folder && same.test(e.name)).sort((a, b) => b.mtime - a.mtime)[0];
  if (!pick) {
    const names = entries.filter((e) => e.folder).map((e) => e.name);
    throw new Error(`No folder called "${folderName}" in /${room}.` + (names.length ? ' Folders there: ' + names.join(', ') : ''));
  }
  const files = await (await get('/api/files?room=' + encodeURIComponent(room) + '&folder=' + encodeURIComponent(pick.name))).json();
  console.log(`\n  Pulling "${pick.name}" from ${base}/${room}`);
  console.log(`  into ${dest}\n`);

  let added = 0, updated = 0, same_ = 0, failed = 0, bytes = 0;
  const queue = files.slice();
  async function one(f) {
    const segs = f.path.split('/');
    const target = path.join(dest, ...segs);
    if (segs.some((s) => !s || s === '.' || s === '..') || !target.startsWith(dest.endsWith(path.sep) ? dest : dest + path.sep)) return;
    const st = await fs.promises.stat(target).catch(() => null);
    if (st && st.isFile() && st.size === f.size && Math.abs(st.mtimeMs - f.mtime) < 2000) { same_++; return; }
    const url = '/files/' + encodeURIComponent(room) + '/' + encodeURIComponent(pick.name) + '/' + segs.map(encodeURIComponent).join('/');
    try {
      const r = await get(url);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const tmp = target + '.lspart';
      await require('node:stream/promises').pipeline(require('node:stream').Readable.fromWeb(r.body), fs.createWriteStream(tmp));
      bytes += f.size;
      // A re-sent folder has new times; don't call a file "updated" if its content didn't change.
      if (st && st.size === f.size && await fileHash(tmp) === await fileHash(target)) {
        await fs.promises.rm(tmp, { force: true });
        await fs.promises.utimes(target, new Date(), new Date(f.mtime));
        same_++;
        return;
      }
      await fs.promises.rename(tmp, target);
      await fs.promises.utimes(target, new Date(), new Date(f.mtime)); // so the next pull can skip it
      if (st) updated++; else added++;
      console.log((st ? '  updated  ' : '  new      ') + f.path);
    } catch (e) {
      failed++;
      console.log('  FAILED   ' + f.path + ' (' + e.message + ')');
    }
  }
  await Promise.all([1, 2, 3, 4].map(async () => { while (queue.length) await one(queue.shift()); }));

  const mb = (bytes / 1048576).toFixed(1);
  console.log(`\n  Done: ${added} new, ${updated} updated, ${same_} unchanged` + (failed ? `, ${failed} failed` : '') + ` (${mb} MB downloaded)\n`);
  if (failed) throw new Error(`${failed} file(s) could not be downloaded. Run the same command again to retry them.`);
}

async function fetchOk(url, opts) {
  let r;
  try { r = await fetch(url, opts); } catch { throw new Error('Could not reach LocalShare at ' + new URL(url).origin); }
  if (r.status === 401) throw new Error('The passcode was refused.');
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${new URL(url).pathname}`);
  return r;
}

function fileHash(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function askLine(q) {
  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
}

// Broadcast "LOCALSHARE?" on every network and wait briefly for hosts to answer.
function discoverHost() {
  return new Promise((resolve, reject) => {
    const sock = require('node:dgram').createSocket('udp4');
    const found = new Map(); // "ip:port" -> hostname
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString());
        if (j.localshare && j.port) found.set(`${rinfo.address}:${j.port}`, j.name || rinfo.address);
      } catch { /* not ours */ }
    });
    sock.on('error', (e) => { sock.close(); reject(new Error('Could not search the network: ' + e.message)); });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const targets = new Set(['255.255.255.255', '127.0.0.1']);
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
          if (a.family !== 'IPv4' && a.family !== 4) continue;
          if (a.internal) continue;
          const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
          targets.add(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'));
        }
      }
      const probe = Buffer.from('LOCALSHARE?');
      const sendAll = () => { for (const t of targets) sock.send(probe, DISCOVERY_PORT, t, () => {}); };
      sendAll();
      setTimeout(sendAll, 400);
      setTimeout(() => {
        sock.close();
        // The same host can answer on several addresses; prefer a LAN one over 127.0.0.1.
        const hosts = new Map();
        for (const [addr, name] of found) {
          const prev = hosts.get(name);
          if (!prev || prev.startsWith('127.')) hosts.set(name, addr);
        }
        if (hosts.size === 1) {
          const [[name, addr]] = hosts;
          console.log(`\n  Found LocalShare on ${name} (${addr})`);
          return resolve('http://' + addr);
        }
        if (!hosts.size) return reject(new Error('Could not find LocalShare on the network. Give its address instead, e.g.\n  pull http://192.168.0.210:8080/<room> <folder>'));
        reject(new Error('Found more than one LocalShare. Give the address of the one you want:\n'
          + [...hosts].map(([n, a]) => `    http://${a}  (${n})`).join('\n')));
      }, 1200);
    });
  });
}
