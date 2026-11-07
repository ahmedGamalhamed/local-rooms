'use strict';
// LocalShare — send messages and files to any device on your LAN through a browser.
// One computer hosts; everyone else joins with a browser. Zero dependencies.
// Run with `node server.js` or use the packaged LocalShare.exe.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream');
const { exec } = require('node:child_process');

let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { /* not packaged */ }

const BASE_DIR = sea ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(BASE_DIR, 'LocalShare Files'); // one sub-folder per room
const CHAT_DIR = path.join(DATA_DIR, '.chat');            // <room>.jsonl message history
const INDEX_HTML = sea
  ? sea.getAsset('index.html', 'utf8')
  : fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const argv = process.argv;
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const START_PORT = parseInt(argVal('--port') || process.env.PORT || '8080', 10);
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
  clients.set(res, { client: String(url.searchParams.get('id') || Math.random()).slice(0, 32), room: r.name });
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

function handleUpload(req, res) {
  let rawName = 'file', from = '', room = '';
  try { rawName = decodeURIComponent(req.headers['x-filename'] || 'file'); } catch { /* keep default */ }
  try { from = decodeURIComponent(req.headers['x-from'] || ''); } catch { /* keep default */ }
  try { room = decodeURIComponent(req.headers['x-room'] || ''); } catch { /* keep default */ }
  const client = String(req.headers['x-client'] || '').slice(0, 32);
  const r = getRoom(cleanRoom(room) || DEFAULT_ROOM);
  const name = uniqueName(r.dir, sanitizeFilename(rawName));
  const dest = path.join(r.dir, name);

  pipeline(req, fs.createWriteStream(dest, { flags: 'wx' }), (err) => {
    if (err) {
      fs.unlink(dest, () => {});
      if (!res.headersSent) json(res, 500, { error: 'Upload failed' });
      return;
    }
    fs.stat(dest, (e, st) => {
      const ev = addEvent(r, { type: 'file', from: cleanName(from), client, name, size: e ? 0 : st.size });
      console.log(`  [${r.name}] ${ev.from} shared "${name}" (${ev.size} bytes)`);
      json(res, 200, { id: ev.id });
    });
  });
}

async function handleListFiles(res, url) {
  const r = rooms.get(cleanRoom(url.searchParams.get('room')));
  if (!r) return json(res, 200, []);
  const ents = await fs.promises.readdir(r.dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    try {
      const st = await fs.promises.stat(path.join(r.dir, e.name));
      files.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
    } catch { /* vanished */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  json(res, 200, files);
}

function handleDownload(req, res, url) {
  const parts = url.pathname.slice('/files/'.length).split('/');
  if (parts.length !== 2) return send(res, 404, 'Not found', 'text/plain');
  let room, name;
  try { room = decodeURIComponent(parts[0]); name = decodeURIComponent(parts[1]); } catch { return send(res, 400, 'Bad name', 'text/plain'); }
  if (!room || cleanRoom(room) !== room) return send(res, 404, 'Not found', 'text/plain');
  if (!name || name !== path.basename(name) || name === '.' || name === '..') return send(res, 404, 'Not found', 'text/plain');
  const fp = path.join(DATA_DIR, room, name);

  fs.stat(fp, (err, st) => {
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
let PORT = START_PORT;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    if (m === 'GET' && p === '/events') return handleEvents(req, res, url);
    if (m === 'GET' && p === '/api/history') return handleHistory(res, url);
    if (m === 'POST' && p === '/api/message') return await handleMessage(req, res);
    if (m === 'POST' && p === '/api/upload') return handleUpload(req, res);
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

process.on('uncaughtException', (e) => console.error(e));
listen(START_PORT, 20);
