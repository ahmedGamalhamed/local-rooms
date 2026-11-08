// LocalShare Remote: rooms that work across the internet, hosted on Cloudflare Workers.
//
// Each room is a Durable Object that keeps the room's messages. Files are never stored:
// sharing a file only posts a card. When someone downloads it, the room asks the sharing
// browser for the bytes over its WebSocket and streams them straight into the download.
// So a file can be downloaded only while the page that shared it is open.
//
// Routes
//   /                        the page (welcome screen)
//   /r/<key>                 the page, opened on a room
//   /r/<key>/ws              WebSocket: messages, room events, and file bytes from senders
//   /r/<key>/f/<fid>/<name>  download a shared file, or a shared folder as .zip
//                            (?path=a/b.txt for one file of a folder, ?view to show inline)
//   /r/<key>/list/<fid>      the files inside a shared folder, as JSON
//
// A room key ("k7f3-m9q2-x8wa", ~59 random bits) is the only way into a room, so the page
// makes keys at random and never lists rooms.
import { DurableObject } from 'cloudflare:workers';
import PAGE from './index.html';

const KEY_RE = /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/;
const FID_RE = /^[a-z0-9]{12,32}$/;
const PAGE_SIZE = 200;          // messages sent when opening a room; older ones on request
const KEEP_EVENTS = 5000;       // older messages are dropped
const MAX_TEXT = 500000;        // characters per message
const IDLE_MS = 30 * 86400e3;   // a room nobody opens for 30 days is deleted
const REPLY_MS = 20000;         // how long to wait for a sender to answer

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
};

const text = (status, body) => new Response(body, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
});
const json = (obj) => new Response(JSON.stringify(obj), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = /^\/r\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const room = m && KEY_RE.test(m[1]) ? m[1] : null;
    if (url.pathname === '/' || (room && (!m[2] || m[2] === '/'))) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed');
      return new Response(PAGE, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          // The room key is in the address: don't hand it to sites linked from the chat.
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        },
      });
    }
    if (!room) return text(404, 'Not found');
    if (req.headers.get('Upgrade') === 'websocket') {
      const origin = req.headers.get('Origin');
      if (origin && origin !== url.origin) return text(403, 'Cross-site connection refused');
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(new Request('https://room' + m[2] + url.search, req));
  },
};

function randomId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Anonymous';
const cleanTitle = (n) => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
function cleanFile(n) {
  let s = String(n || '').replace(/\\/g, '/').split('/').pop();
  s = s.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  return s.slice(0, 180) || 'file';
}
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const ext = (name) => { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; };

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
    this.transfers = new Map(); // tid -> download waiting for or receiving a sender's bytes
    this.asks = new Map();      // rid -> folder listing waiting for a sender's answer
    this.seq = 1;
    // Keep-alive pings are answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, fid TEXT, owner TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_fid ON events (fid);
      CREATE TABLE IF NOT EXISTS owners (secret TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  }

  async fetch(req) {
    this.init(); // tables are gone after an idle room was cleared
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.connect(req, url);
    let m = /^\/f\/([a-z0-9]{12,32})(?:\/[^/]*)?$/.exec(url.pathname);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return this.download(req, url, m[1]);
    m = /^\/list\/([a-z0-9]{12,32})$/.exec(url.pathname);
    if (m && req.method === 'GET') return this.list(m[1]);
    return text(404, 'Not found');
  }

  // ---------- people in the room ----------
  // Each page sends a random secret for itself. The room maps it to a public "owner" id
  // that marks the files that page shares, so nobody else can answer for those files,
  // and a page that reconnects after a network drop serves them again.
  connect(req, url) {
    if (req.headers.get('Upgrade') !== 'websocket') return text(426, 'Expected a WebSocket');
    const secret = url.searchParams.get('tab') || '';
    if (!/^[A-Za-z0-9]{16,64}$/.test(secret)) return text(400, 'Bad request');
    const client = String(url.searchParams.get('client') || '').slice(0, 32);
    let owner = this.sql.exec('SELECT owner FROM owners WHERE secret = ?', secret).toArray()[0]?.owner;
    if (!owner) {
      owner = randomId();
      this.sql.exec('INSERT INTO owners (secret, owner) VALUES (?, ?)', secret, owner);
    }
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws, [owner]);
    ws.serializeAttachment({ client, owner, sid: randomId() });
    ws.send(JSON.stringify(Object.assign(this.history(), this.online())));
    this.broadcast(Object.assign({ type: 'online' }, this.online()), ws);
    this.touch();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  history() {
    const rows = this.sql.exec('SELECT data FROM events ORDER BY id DESC LIMIT ?', PAGE_SIZE + 1).toArray();
    return {
      type: 'history',
      title: this.title(),
      events: rows.slice(0, PAGE_SIZE).reverse().map((r) => JSON.parse(r.data)),
      hasMore: rows.length > PAGE_SIZE,
    };
  }

  online(gone) {
    const devices = new Set(), owners = new Set();
    for (const ws of this.sockets(gone)) {
      const a = ws.deserializeAttachment();
      devices.add(a.client || a.owner);
      owners.add(a.owner);
    }
    return { devices: devices.size, owners: [...owners] };
  }

  sockets(gone, tag) {
    const all = tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets();
    return all.filter((ws) => ws !== gone && ws.deserializeAttachment());
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.sockets(except)) { try { ws.send(s); } catch { /* closing */ } }
  }

  title() { return this.sql.exec("SELECT v FROM meta WHERE k = 'title'").toArray()[0]?.v || ''; }

  touch() { this.ctx.storage.setAlarm(Date.now() + IDLE_MS); }

  async alarm() {
    if (this.ctx.getWebSockets().length) return this.touch();
    await this.ctx.storage.deleteAll();
  }

  add(ev, fid = null, owner = null) {
    ev.id = this.sql.exec('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM events').one().n;
    ev.time = Date.now();
    this.sql.exec('INSERT INTO events (id, fid, owner, data) VALUES (?, ?, ?, ?)', ev.id, fid, owner, JSON.stringify(ev));
    if (ev.id % 100 === 0) this.sql.exec('DELETE FROM events WHERE id <= ?', ev.id - KEEP_EVENTS);
    this.touch();
    this.broadcast(ev);
  }

  // ---------- messages from pages ----------
  async webSocketMessage(ws, msg) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    if (typeof msg !== 'string') return this.chunk(me, ws, msg);
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const tell = (error) => ws.send(JSON.stringify({ type: 'error', error }));

    switch (m.t) {
      case 'msg': {
        const t = typeof m.text === 'string' ? m.text : '';
        if (!t.trim()) return;
        if (t.length > MAX_TEXT) return tell('That message is too long. Send it as a .txt file instead.');
        return this.add({ type: 'msg', from: cleanName(m.from), client: me.client, text: t });
      }
      case 'offer': {
        const fid = String(m.fid || '');
        if (!FID_RE.test(fid) || this.sql.exec('SELECT 1 FROM events WHERE fid = ?', fid).toArray().length) return;
        const folder = m.kind === 'folder';
        const ev = { type: folder ? 'folder' : 'file', from: cleanName(m.from), client: me.client, owner: me.owner, fid, name: cleanFile(m.name), size: count(m.size) };
        if (folder) {
          ev.count = count(m.count);
          const skipped = Array.isArray(m.skipped) ? m.skipped.map((s) => String(s).slice(0, 120)).filter(Boolean).slice(0, 30) : [];
          if (skipped.length) { ev.skipped = skipped; ev.skippedTotal = Math.min(Math.max(skipped.length, count(m.skippedTotal)), 1e6); }
        }
        return this.add(ev, fid, me.owner);
      }
      case 'title': { // only the page that made the room names it, once
        const t = cleanTitle(m.title);
        if (!t || this.title()) return;
        this.sql.exec("INSERT INTO meta (k, v) VALUES ('title', ?)", t);
        return this.broadcast({ type: 'title', title: t });
      }
      case 'history':
        return ws.send(JSON.stringify(Object.assign(this.history(), this.online())));
      case 'older': {
        const rows = this.sql.exec('SELECT data FROM events WHERE id < ? ORDER BY id DESC LIMIT ?', Number(m.before) || 0, PAGE_SIZE + 1).toArray();
        return ws.send(JSON.stringify({ type: 'older', events: rows.slice(0, PAGE_SIZE).reverse().map((r) => JSON.parse(r.data)), hasMore: rows.length > PAGE_SIZE }));
      }
      case 'files': {
        const rows = this.sql.exec('SELECT data FROM events WHERE fid IS NOT NULL ORDER BY id DESC LIMIT 500').toArray();
        return ws.send(JSON.stringify({ type: 'files', events: rows.map((r) => JSON.parse(r.data)) }));
      }
      // A sender answering a download request
      case 'start':
      case 'fail': {
        const t = this.transfers.get(m.tid);
        if (!t || t.sid !== me.sid) return;
        if (t.answer) return t.answer(m);       // before the download has started
        if (m.t === 'fail') this.stop(m.tid);   // in the middle: cut it off
        return;
      }
      case 'end': {
        const t = this.transfers.get(m.tid);
        if (!t || t.sid !== me.sid) return;
        this.transfers.delete(m.tid);
        if (t.writer) t.writer.close().catch(() => {});
        else t.ended = true;
        return;
      }
      case 'listed': {
        const a = this.asks.get(m.rid);
        if (!a || a.sid !== me.sid || !Array.isArray(m.files)) return;
        for (const f of m.files.slice(0, 200000 - a.files.length)) {
          if (f && typeof f.path === 'string') a.files.push({ path: f.path.slice(0, 2000), size: count(f.size), mtime: Number(f.mtime) || 0 });
        }
        if (m.done) a.resolve(a.files);
        return;
      }
    }
  }

  async webSocketClose(ws) {
    this.gone(ws);
    try { ws.close(1000); } catch { /* already closed */ }
  }

  async webSocketError(ws) { this.gone(ws); }

  gone(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    for (const [tid, t] of this.transfers) {
      if (t.sid !== me.sid) continue;
      if (t.answer) t.answer({ t: 'fail', status: 410, error: 'The sender went offline.' });
      else this.stop(tid);
    }
    for (const a of this.asks.values()) if (a.sid === me.sid) a.resolve(null);
    this.broadcast(Object.assign({ type: 'online' }, this.online(ws)), ws);
  }

  // ---------- downloads ----------
  async download(req, url, fid) {
    const row = this.sql.exec('SELECT owner, data FROM events WHERE fid = ?', fid).toArray()[0];
    if (!row) return text(404, 'This file is not shared in this room.');
    const ev = JSON.parse(row.data);
    const ws = this.sockets(null, row.owner).pop();
    if (!ws) return text(410, 'The person who shared this is offline. It can be downloaded once they open this room again on the page they shared it from.');
    const path = url.searchParams.get('path');
    if (path != null && ev.type !== 'folder') return text(404, 'Not found');
    const zip = ev.type === 'folder' && path == null;
    const range = req.headers.get('Range');
    const head = req.method === 'HEAD';

    const tid = this.seq++;
    const t = { sid: ws.deserializeAttachment().sid, writer: null, early: [], ended: false };
    const answer = new Promise((resolve) => { t.answer = resolve; });
    const timer = setTimeout(() => t.answer({ t: 'fail', status: 504, error: 'The sender did not respond. Try again.' }), REPLY_MS);
    this.transfers.set(tid, t);
    ws.send(JSON.stringify({ type: 'pull', tid, fid, path, range: zip ? null : range, head }));
    const a = await answer;
    clearTimeout(timer);
    t.answer = null;
    if (a.t === 'fail') {
      this.transfers.delete(tid);
      return text(a.status === 404 || a.status === 410 ? a.status : 502, String(a.error || 'The sender could not send this file.').slice(0, 300));
    }

    const name = zip ? ev.name + '.zip' : path != null ? cleanFile(path) : ev.name;
    const mime = MIME[ext(name)];
    const inline = url.searchParams.has('view') && mime && !zip;
    const headers = {
      'Content-Type': inline ? mime : zip ? 'application/zip' : 'application/octet-stream',
      'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    let status = 200, length = null;
    if (!zip) {
      const size = count(a.size);
      if (a.status === 416) {
        this.transfers.delete(tid);
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const start = count(a.start), end = Number.isSafeInteger(a.end) ? a.end : size - 1;
      if (start > end + 1 || end >= size) { this.transfers.delete(tid); return text(502, 'The sender sent a bad answer.'); }
      headers['Accept-Ranges'] = 'bytes';
      length = end - start + 1;
      if (a.partial) { status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`; }
    }
    if (head || length === 0) {
      this.transfers.delete(tid);
      if (length != null) headers['Content-Length'] = String(length);
      return new Response(null, { status, headers });
    }
    // A known length gives the browser a progress bar.
    const stream = length != null ? new FixedLengthStream(length) : new TransformStream();
    t.writer = stream.writable.getWriter();
    for (const c of t.early) this.write(tid, t, c);
    t.early = null;
    if (t.ended) t.writer.close().catch(() => {});
    return new Response(stream.readable, { status, headers });
  }

  // Bytes from a sender: [uint32 LE transfer id][data]. Each piece is acknowledged once the
  // download has taken it, and the sender keeps only a few MB unacknowledged, so a slow
  // downloader slows the sender instead of filling memory here.
  chunk(me, ws, buf) {
    if (buf.byteLength < 4) return;
    const tid = new DataView(buf).getUint32(0, true);
    const t = this.transfers.get(tid);
    if (!t || t.sid !== me.sid) return;
    const data = new Uint8Array(buf, 4);
    if (!t.writer) { if (t.early) t.early.push(data); return; }
    this.write(tid, t, data, ws);
  }

  write(tid, t, data, ws) {
    t.writer.write(data).then(
      () => {
        const sock = ws || this.sockets().find((s) => s.deserializeAttachment().sid === t.sid);
        try { sock?.send(JSON.stringify({ type: 'ack', tid, n: data.length })); } catch { /* sender gone */ }
      },
      () => this.stop(tid, true), // the downloader went away
    );
  }

  stop(tid, tellSender) {
    const t = this.transfers.get(tid);
    if (!t) return;
    this.transfers.delete(tid);
    if (t.writer) t.writer.abort(new Error('Transfer stopped')).catch(() => {});
    if (tellSender) {
      const sock = this.sockets().find((s) => s.deserializeAttachment().sid === t.sid);
      try { sock?.send(JSON.stringify({ type: 'cancel', tid })); } catch { /* sender gone */ }
    }
  }

  async list(fid) {
    const row = this.sql.exec('SELECT owner, data FROM events WHERE fid = ?', fid).toArray()[0];
    if (!row || JSON.parse(row.data).type !== 'folder') return text(404, 'This folder is not shared in this room.');
    const ws = this.sockets(null, row.owner).pop();
    if (!ws) return text(410, 'The person who shared this folder is offline.');
    const rid = this.seq++;
    const a = { sid: ws.deserializeAttachment().sid, files: [] };
    const done = new Promise((resolve) => { a.resolve = resolve; });
    const timer = setTimeout(() => a.resolve(null), REPLY_MS);
    this.asks.set(rid, a);
    ws.send(JSON.stringify({ type: 'list', rid, fid }));
    const files = await done;
    clearTimeout(timer);
    this.asks.delete(rid);
    return files ? json(files) : text(504, 'The sender did not respond. Try again.');
  }
}
