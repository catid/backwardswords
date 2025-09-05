const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const url = require('url');
const { spawnSync } = require('child_process');
const Wav = require('node-wav');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function uuid() { return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); }
const crypto = require('crypto').webcrypto;

function now() { return Date.now() / 1000; }

function sanitizeToken(str) {
  let s = String(str || '');
  s = s.replace(/\s+/g, '_');
  s = s.replace(/[^A-Za-z0-9_]/g, '');
  return s.toUpperCase();
}

class Player {
  constructor(id, name, avatar=null) { this.id = id; this.name = name; this.avatar = avatar; this.connected = false; }
}

class RoundState {
  constructor(index, leadId, participants) {
    this.index = index;
    this.lead_player_id = leadId;
    this.participant_ids = Array.from(new Set(participants || []));
    this.state = 'lead_record';
    // Leader gets unlimited time to submit the initial clip
    this.deadline = Infinity;
    this.lead_clip_path = null;
    this.lead_clip_rev_path = null;
    this.replicates = {}; // playerId -> path
    this.replicates_rev = {}; // playerId -> reversed wav path
    this.votes = {}; // playerId -> [first, second]
  }
}

class Game {
  constructor(code) {
    this.code = code;
    this.players = {};
    this.scores = {};
    this.rounds = [];
    this.current_round = null;
    this.sseClients = new Map();
    this.lobby_ready = {}; // pid -> bool (only used when current_round is null)
  }
  dir() { const d = path.join(DATA_DIR, this.code); fs.mkdirSync(d, { recursive: true }); return d; }
  clipUrl(p) {
    if (!p) return null;
    // Serve anything relative to DATA_DIR to preserve round subfolders
    let rel = path.relative(DATA_DIR, p);
    rel = rel.split(path.sep).join('/');
    return `/audio/${rel}`;
  }
  toPublic(requester) {
    const players = Object.values(this.players).map(p => ({ id: p.id, name: p.name, avatar: p.avatar || null, connected: p.connected }));
    let cur = null;
    const lobbyReadyStatus = this.current_round ? null : Object.fromEntries(Object.keys(this.players).map(pid => [pid, !!this.lobby_ready[pid]]));
    if (this.current_round) {
      const r = this.current_round;
      cur = {
        index: r.index,
        state: r.state,
        participantIds: r.participant_ids,
        deadline: r.deadline,
        leadPlayerId: r.lead_player_id,
        leadClipUrl: this.clipUrl(r.lead_clip_path),
        leadClipRevUrl: this.clipUrl(r.lead_clip_rev_path),
        replicateStatus: Object.fromEntries(r.participant_ids.map(pid => [pid, !!r.replicates[pid]])),
        votesStatus: Object.fromEntries(r.participant_ids.map(pid => [pid, !!r.votes[pid]])),
      };
      const canSeeVotesEarly = (r.state === 'replicate') && (requester === r.lead_player_id || !!r.replicates[requester]);
      const isParticipant = requester && r.participant_ids.includes(requester);
      const canShowClips = (r.state === 'voting') ? !!isParticipant
                          : (r.state === 'scoreboard') ? true
                          : canSeeVotesEarly;
      if (requester && canShowClips) {
        const items = Object.entries(r.replicates); // include everyone's clip for visibility
        const seed = `${this.code}:${r.index}:${requester}`;
        const rng = mulberry32(hashStr(seed));
        shuffle(items, rng);
        cur.voteClips = items.map(([pid, pth], i) => ({
          id: `clip_${i}`,
          clipUrl: this.clipUrl(pth),
          revClipUrl: this.clipUrl(r.replicates_rev[pid] || null),
          ownerHiddenId: pid
        }));
      }
    }
    return {
      code: this.code,
      players,
      currentRound: cur,
      scores: this.scores,
      lobbyReadyStatus,
    };
  }
}

const GAMES = new Map();
function getGame(code) { code = code.toUpperCase(); let g = GAMES.get(code); if (!g) { g = new Game(code); GAMES.set(code, g); } return g; }

function sendState(game) {
  for (const [res, pid] of Array.from(game.sseClients.entries())) {
    const payload = JSON.stringify({ type: 'state', state: game.toPublic(pid) });
    try { res.write(`data: ${payload}\n\n`); } catch { game.sseClients.delete(res); }
  }
}

function parseJSON(req) { return new Promise(resolve => { let body = ''; req.on('data', d => body += d); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } }); }); }
function collectBinary(req) { return new Promise(resolve => { const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => resolve(Buffer.concat(chunks))); }); }

function hashStr(s) { let h = 1779033703 ^ s.length; for (let i=0;i<s.length;i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return (h>>>0); }
function mulberry32(a){ return function(){ let t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; } }
function shuffle(arr, rng=Math.random){ for (let i=arr.length-1;i>0;i--){ const j = Math.floor(rng()* (i+1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } }

function contentTypeToExt(ctype) {
  ctype = String(ctype || '').toLowerCase();
  if (ctype.includes('webm')) return '.webm';
  if (ctype.includes('wav')) return '.wav';
  if (ctype.includes('aac')) return '.aac';
  if (ctype.includes('mp4') || ctype.includes('m4a')) return '.m4a';
  return '.bin';
}

function sniffExt(buf) {
  if (!buf || buf.length < 12) return null;
  // EBML (WebM/Matroska) magic: 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
  // RIFF....WAVE
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) return '.wav';
  // OggS
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return '.ogg';
  // ADTS AAC sync: 0xFFF1 or 0xFFF9
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return '.aac';
  // ISO BMFF (MP4/M4A): '....ftyp'
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return '.m4a';
  return null;
}

async function route(req, res) {
  const u = url.parse(req.url, true);
  const { pathname, query } = u;
  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    return fs.createReadStream(path.join(__dirname, 'app', 'static', 'index.html')).pipe(res);
  }
  if (pathname === '/favicon.ico') {
    const p = path.join(__dirname, 'app', 'static', 'favicon.svg');
    res.setHeader('Content-Type', 'image/svg+xml');
    return fs.createReadStream(p).on('error', () => { res.statusCode = 204; res.end(); }).pipe(res);
  }
  if (pathname.startsWith('/static/')) {
    const p = path.join(__dirname, 'app', pathname);
    return fs.createReadStream(p).on('error', () => { res.statusCode = 404; res.end('Not found'); }).pipe(res);
  }
  if (pathname.startsWith('/audio/')) {
    const rel = pathname.replace('/audio/', '');
    const p = path.join(DATA_DIR, rel);
    try {
      const stat = fs.statSync(p);
      const size = stat.size;
      // MIME
      const ext = path.extname(p).toLowerCase();
      const type = ext === '.webm' ? 'audio/webm'
                 : ext === '.ogg' ? 'audio/ogg'
                 : ext === '.wav' ? 'audio/wav'
                 : ext === '.m4a' || ext === '.mp4' ? 'audio/mp4'
                 : ext === '.aac' ? 'audio/aac' : 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

      const range = req.headers.range;
      if (range) {
        // bytes=start-end
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = 0, end = size - 1;
        if (m) {
          if (m[1] !== '') start = parseInt(m[1], 10);
          if (m[2] !== '') end = parseInt(m[2], 10);
        }
        if (isNaN(start) || isNaN(end) || start > end || start >= size) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.end();
        }
        end = Math.min(end, size - 1);
        const chunk = (end - start) + 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', chunk);
        const stream = fs.createReadStream(p, { start, end });
        stream.pipe(res);
        stream.on('error', () => { try { res.destroy(); } catch {} });
        return;
      } else {
        res.setHeader('Content-Length', size);
        const stream = fs.createReadStream(p);
        stream.pipe(res);
        stream.on('error', () => { try { res.destroy(); } catch {} });
        return;
      }
    } catch (e) {
      res.statusCode = 404; res.end('Not found');
      return;
    }
  }

async function reverseWav(inputPath, outputPath) {
  const buf = await fsp.readFile(inputPath);
  const wav = Wav.decode(buf);
  if (!wav || !wav.channelData || !wav.channelData.length) throw new Error('Invalid WAV');
  const reversed = wav.channelData.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0, j = ch.length - 1; i < ch.length; i++, j--) out[i] = ch[j];
    return out;
  });
  // Encode as 16-bit PCM for maximum compatibility
  const outBuf = Wav.encode(reversed, { sampleRate: wav.sampleRate, float: false, bitDepth: 16 });
  await fsp.writeFile(outputPath, Buffer.from(outBuf));
  return outputPath;
}

  // CORS for APIs
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 200; return res.end(); }

  if (pathname === '/join' && req.method === 'POST') {
    const body = await parseJSON(req);
    const code = sanitizeToken(body.code);
    const name = sanitizeToken(body.name);
    const avatar = String(body.avatar || '').trim().slice(0, 4); // emoji or short token
    const game = getGame(code);
    let pid = null;
    // Ensure case-insensitive reuse by comparing uppercase
    for (const p of Object.values(game.players)) if ((p.name || '').toUpperCase() === name) { pid = p.id; break; }
    if (!pid) { pid = uuid(); game.players[pid] = new Player(pid, name, avatar || null); game.scores[pid] = game.scores[pid] || 0; }
    if (!game.current_round) game.lobby_ready[pid] = false; // default not ready
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: game.code, playerId: pid, state: game.toPublic(pid) }));
    sendState(game);
    return;
  }

  if (pathname === '/sse' && req.method === 'GET') {
    const code = sanitizeToken(query.code);
    const playerId = String(query.playerId || '');
    const game = getGame(code);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    game.sseClients.set(res, playerId);
    if (game.players[playerId]) game.players[playerId].connected = true;
    // Default lobby not-ready for newly connected players when in lobby
    if (!game.current_round && playerId) game.lobby_ready[playerId] = !!game.lobby_ready[playerId];
    const payload = JSON.stringify({ type: 'state', state: game.toPublic(playerId) });
    res.write(`data: ${payload}\n\n`);
    req.on('close', () => {
      game.sseClients.delete(res);
      if (game.players[playerId]) game.players[playerId].connected = false;
      sendState(game);
    });
    return;
  }

  if (pathname === '/lobby/ready' && req.method === 'POST') {
    const body = await parseJSON(req);
    const code = String(body.code || '').toUpperCase();
    const pid = String(body.playerId || '');
    const ready = !!body.ready;
    const game = getGame(code);
    if (!game.players[pid]) { res.statusCode = 400; return res.end('Unknown player'); }
    if (game.current_round) { res.statusCode = 409; return res.end('Round already started'); }
    game.lobby_ready[pid] = ready;
    // Auto-start when at least 2 CONNECTED players are ready, regardless of others
    const readyConnected = Object.keys(game.lobby_ready).filter(id => game.lobby_ready[id] && game.players[id] && game.players[id].connected);
    if (!game.current_round && readyConnected.length >= 2) {
      const participants = readyConnected.slice();
      const lead = participants[Math.floor(now()) % participants.length];
      game.current_round = new RoundState(1, lead, participants);
      game.lobby_ready = {}; // clear lobby ready once game starts
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, started: !!game.current_round }));
    sendState(game);
    return;
  }

  if (pathname === '/upload/lead' && req.method === 'POST') {
    const code = sanitizeToken(query.code);
    const playerId = String(query.playerId || '');
    const game = getGame(code);
    const r = game.current_round;
    if (!r || r.state !== 'lead_record' || r.lead_player_id !== playerId) { res.statusCode = 400; return res.end('Not accepting lead'); }
    const buf = await collectBinary(req);
    const extHeader = contentTypeToExt(req.headers['content-type']);
    const dir = path.join(game.dir(), `round_${r.index}`);
    fs.mkdirSync(dir, { recursive: true });
    const extSniff = sniffExt(buf) || extHeader || '.bin';
    const fname = `lead_${uuid()}${extSniff}`;
    const pth = path.join(dir, fname);
    await fsp.writeFile(pth, buf);
    r.lead_clip_path = pth;
    // Generate reversed WAV before switching state so mobiles can play immediately
    try {
      r.lead_clip_rev_path = await reverseWav(pth, path.join(dir, `lead_rev_${uuid()}.wav`));
    } catch (e) {
      console.error('Reverse generation failed:', e && e.message ? e.message : e);
      r.lead_clip_rev_path = null;
    }
    r.state = 'replicate';
    r.deadline = Infinity; // wait indefinitely for all players to submit
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, leadClipUrl: game.clipUrl(pth) }));
    sendState(game);
    return;
  }

  if (pathname === '/upload/replicate' && req.method === 'POST') {
    const code = sanitizeToken(query.code);
    const playerId = String(query.playerId || '');
    const game = getGame(code);
    const r = game.current_round;
    if (!r || r.state !== 'replicate') { res.statusCode = 400; return res.end('Not accepting replicate'); }
    // Only round participants may submit for this round
    if (!r.participant_ids.includes(playerId)) { res.statusCode = 403; return res.end('Not a participant this round'); }
    const buf = await collectBinary(req);
    const extHeader = contentTypeToExt(req.headers['content-type']);
    const dir = path.join(game.dir(), `round_${r.index}`);
    fs.mkdirSync(dir, { recursive: true });
    const extSniff = sniffExt(buf) || extHeader || '.bin';
    const fname = `rep_${playerId}_${uuid()}${extSniff}`;
    const pth = path.join(dir, fname);
    await fsp.writeFile(pth, buf);
    r.replicates[playerId] = pth;
    // Generate reversed WAV for robust mobile playback
    try {
      const revPath = await reverseWav(pth, path.join(dir, `rep_rev_${playerId}_${uuid()}.wav`));
      r.replicates_rev[playerId] = revPath;
    } catch (e) {
      console.error('Reverse generation failed (replicate):', e && e.message ? e.message : e);
      r.replicates_rev[playerId] = null;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, clipUrl: game.clipUrl(pth) }));
    // If all participants (including lead) have submitted, move to voting
    const need = r.participant_ids;
    const done = need.every(pid => !!r.replicates[pid]);
    if (done) { r.state = 'voting'; r.deadline = Infinity; }
    sendState(game);
    return;
  }

  if (pathname === '/vote' && req.method === 'POST') {
    const body = await parseJSON(req);
    const code = sanitizeToken(body.code);
    const game = getGame(code);
    const r = game.current_round;
    if (!r || r.state !== 'voting') { res.statusCode = 400; return res.end('Not voting'); }
    const pid = String(body.playerId || '');
    if (!r.participant_ids.includes(pid)) { res.statusCode = 403; return res.end('Spectators cannot vote'); }
    let first = body.first ? String(body.first) : null;
    let second = body.second ? String(body.second) : null;
    // Only enforce distinct choices if there are at least two clips to choose from
    const availableChoices = Object.keys(r.replicates).filter(id => id !== pid);
    const mustDiffer = availableChoices.length >= 2;
    if (mustDiffer && first && second && first === second) { res.statusCode = 400; return res.end('choices must differ'); }
    r.votes[pid] = [first, second];
    // If all players have voted, tally now
    const ids = r.participant_ids;
    const allVoted = ids.every(id => !!r.votes[id]);
    if (allVoted) {
      tallyAndFinish(game);
      r.deadline = now() + 30;
    }
    sendState(game);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, done: allVoted }));
    return;
  }

  if (pathname === '/control/start_next_round' && req.method === 'POST') {
    const body = await parseJSON(req);
    const code = sanitizeToken(body.code);
    const game = getGame(code);
    const r = game.current_round;
    if (!r || r.state !== 'scoreboard') { res.statusCode = 400; return res.end('Not at end'); }
    const ids = Object.keys(game.players).filter(id => game.players[id].connected);
    if (!ids.length) { res.statusCode = 400; return res.end('No connected players'); }
    const prev = r.lead_player_id; let idx = ids.indexOf(prev); if (idx < 0) idx = -1; idx = (idx + 1) % ids.length;
    const nextLead = ids[idx];
    game.rounds.push(r);
    game.current_round = new RoundState(r.index + 1, nextLead, ids);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    sendState(game);
    return;
  }

  if (pathname === '/state' && req.method === 'GET') {
    const code = sanitizeToken(query.code);
    const playerId = String(query.playerId || '');
    const game = getGame(code);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(game.toPublic(playerId)));
    return;
  }

  res.statusCode = 404; res.end('Not found');
}

function tallyAndFinish(game) {
  const r = game.current_round; if (!r) return;
  const pts = {}; Object.keys(game.players).forEach(pid => pts[pid] = 0);
  // Count only votes from participants to avoid spectators influencing results
  Object.entries(r.votes).forEach(([voter, pair]) => {
    if (!r.participant_ids.includes(voter)) return;
    const [first, second] = pair;
    // Crown system: first choice (crown) gives 1 point; second gives 0
    if (first && game.players[first]) pts[first] += 1;
  });
  for (const [pid, p] of Object.entries(pts)) game.scores[pid] = (game.scores[pid] || 0) + p;
  r.state = 'scoreboard';
  r.deadline = now() + 30;
}

setInterval(() => {
  for (const game of GAMES.values()) {
    const r = game.current_round; if (!r) continue;
    if (now() < r.deadline) continue;
    if (r.state === 'replicate') {
      r.state = 'voting'; r.deadline = Infinity;
    } else if (r.state === 'voting') {
      // Wait indefinitely for all votes; no auto-advance here
      continue;
    } else if (r.state === 'scoreboard') {
      // Auto-advance to next round
      const ids = Object.keys(game.players).filter(id => game.players[id].connected);
      if (!ids.length) continue;
      const prev = r.lead_player_id; let idx = ids.indexOf(prev); if (idx < 0) idx = -1; idx = (idx + 1) % ids.length;
      const nextLead = ids[idx];
      game.rounds.push(r);
      game.current_round = new RoundState(r.index + 1, nextLead, ids);
    }
    sendState(game);
  }
}, 500);

async function ensureCert() {
  // Allow env to provide cert directly
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    return { key: process.env.SSL_KEY, cert: process.env.SSL_CERT, source: 'env' };
  }

  // Allow env to point to files
  if (process.env.SSL_KEY_FILE && process.env.SSL_CERT_FILE) {
    try {
      const key = await fsp.readFile(process.env.SSL_KEY_FILE);
      const cert = await fsp.readFile(process.env.SSL_CERT_FILE);
      // Optional chain file for certain providers
      let ca;
      if (process.env.SSL_CA_FILE) {
        try { ca = await fsp.readFile(process.env.SSL_CA_FILE); } catch {}
      }
      return ca ? { key, cert, ca, source: 'files+ca' } : { key, cert, source: 'files' };
    } catch (e) { /* fallthrough */ }
  }

  // Prefer domain-specific certs at repo root if present
  try {
    const keyPath = path.join(__dirname, 'backwardswords.com.key');
    const certPath = path.join(__dirname, 'backwardswords.com.pem');
    const [key, cert] = await Promise.all([fsp.readFile(keyPath), fsp.readFile(certPath)]);
    return { key, cert, source: 'backwardswords.com.*' };
  } catch {}

  // Use certs in local cert folder if present
  const certDir = path.join(__dirname, 'cert');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  try {
    const [key, cert] = await Promise.all([fsp.readFile(keyPath), fsp.readFile(certPath)]);
    return { key, cert, source: 'cert/' };
  } catch {}

  // Try mkcert if installed
  try {
    fs.mkdirSync(certDir, { recursive: true });
    const hosts = ['localhost', '127.0.0.1', '::1', 'ai.lan'];
    const args = ['-key-file', keyPath, '-cert-file', certPath, ...hosts];
    const res = spawnSync('mkcert', args, { stdio: 'ignore' });
    if (res.status === 0) {
      const [key, cert] = await Promise.all([fsp.readFile(keyPath), fsp.readFile(certPath)]);
      return { key, cert, source: 'mkcert' };
    }
  } catch {}

  // Fallback: generate self-signed cert (untrusted) for development
  try {
    const selfsigned = require('selfsigned');
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    const alt = [
      { type: 2, value: 'localhost' }, // DNS
      { type: 2, value: 'ai.lan' },
      { type: 7, ip: '127.0.0.1' }, // IP
      { type: 7, ip: '::1' }
    ];
    const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames: alt }] });
    // Persist for reuse
    try {
      fs.mkdirSync(certDir, { recursive: true });
      await Promise.all([fsp.writeFile(keyPath, pems.private), fsp.writeFile(certPath, pems.cert)]);
    } catch {}
    return { key: pems.private, cert: pems.cert, source: 'selfsigned' };
  } catch (e) {
    console.warn('Could not generate self-signed certificate; install "selfsigned" package.\n  npm i --save selfsigned');
    throw e;
  }
}

(async () => {
  const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
  const HTTPS_PORT = process.env.HTTPS_PORT ? parseInt(process.env.HTTPS_PORT, 10) : 8443;

  let creds;
  try {
    creds = await ensureCert();
  } catch (e) {
    console.error('Failed to obtain TLS certificate:', e && e.message ? e.message : e);
    console.error('Starting HTTP only. getUserMedia will be blocked unless using localhost.');
    const server = http.createServer(route);
    server.listen(HTTP_PORT, '0.0.0.0', () => console.log('HTTP on http://0.0.0.0:' + HTTP_PORT));
    return;
  }

  // HTTPS server for app
  const httpsOptions = { key: creds.key, cert: creds.cert };
  if (creds.ca) httpsOptions.ca = creds.ca;
  const httpsServer = https.createServer(httpsOptions, route);
  httpsServer.on('error', (err) => {
    console.error('HTTPS server error:', err && err.message ? err.message : err);
  });
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS on https://0.0.0.0:${HTTPS_PORT}  [cert: ${creds.source}]`);
  });

  // HTTP server: serve app directly when behind a reverse proxy (e.g., Cloudflare),
  // otherwise redirect non-local hosts to HTTPS on the configured port for local/LAN use.
  function isLocalHost(h) { return h === 'localhost' || h === '127.0.0.1' || h === '::1'; }
  const httpServer = http.createServer((req, res) => {
    const hostHeader = req.headers.host || '';
    const [hostOnly] = hostHeader.split(':');
    const behindProxy = !!(req.headers['x-forwarded-proto'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-host']);
    if (behindProxy || isLocalHost(hostOnly)) {
      return route(req, res);
    }
    // Not behind a proxy: redirect to HTTPS using the configured HTTPS_PORT
    const targetHost = `${hostOnly}:${HTTPS_PORT}`;
    const loc = `https://${targetHost}${req.url}`;
    res.statusCode = 307;
    res.setHeader('Location', loc);
    res.end(`Redirecting to ${loc}`);
  });
  httpServer.on('error', (err) => {
    console.error('HTTP server error:', err && err.message ? err.message : err);
  });
  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`HTTP on http://0.0.0.0:${HTTP_PORT}  (serves for localhost; redirects other hosts to https://<host>:${HTTPS_PORT})`);
  });
})();
