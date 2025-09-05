let state = null;
let my = { code: null, id: null, name: null, avatar: null };
let evs = null;
let leadMedia = { chunks: [], recorder: null, lastBlob: null };
let repMedia = { chunks: [], recorder: null, lastBlob: null, autoUploadTimeout: null };
let audioCtx = null;
const AUDIO_SCALE = 2; // Keep in sync with CSS .audio-large transform
let selectedCrown = null; // ownerHiddenId crowned by this player
let lastRoundIndex = null; // track when a new round starts

// Media helpers
function isSecure() { return !!window.isSecureContext; }
function hasModernGetUserMedia() { return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'); }
function getLegacyGetUserMedia() {
  return navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
}

async function getMicStream() {
  // getUserMedia requires a secure context (HTTPS or localhost) in modern browsers
  if (!isSecure()) {
    throw new Error('Microphone access requires a secure context (HTTPS or localhost).');
  }
  if (hasModernGetUserMedia()) {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  const legacy = getLegacyGetUserMedia();
  if (legacy) {
    return await new Promise((resolve, reject) => legacy.call(navigator, { audio: true }, resolve, reject));
  }
  throw new Error('getUserMedia is not available in this browser.');
}

function disableRecordingUI(reason) {
  const btns = ['#lead-rec-btn', '#rep-rec-btn'].map(sel => document.querySelector(sel)).filter(Boolean);
  btns.forEach(b => { b.disabled = true; b.title = reason; });
}

function maybeWarnInsecureContext() {
  if (!isSecure()) {
    console.warn('Insecure context detected. Microphone APIs are disabled by the browser.');
    disableRecordingUI('Enable HTTPS or use localhost to record audio');
    // Lightweight inline notice
    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;padding:10px;background:#fff3cd;color:#664d03;border:1px solid #ffecb5;border-radius:6px;z-index:9999;font-size:14px;';
    note.textContent = 'Microphone disabled: open this site over HTTPS or on localhost (secure context required).';
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 8000);
  } else if (!hasModernGetUserMedia() && !getLegacyGetUserMedia()) {
    disableRecordingUI('This browser does not support getUserMedia');
  }
}

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  });
  children.forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
}

function show(id) { document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden')); if (id) $(id).classList.remove('hidden'); }

function adjustAudioRows() {
  document.querySelectorAll('.audio-row').forEach(row => {
    const audio = row.querySelector('audio.audio-large');
    if (!audio) return;
    const cs = getComputedStyle(audio);
    const hasTransform = cs.transform && cs.transform !== 'none';
    if (!hasTransform) {
      row.style.minHeight = '';
    } else {
      const baseH = audio.offsetHeight || 36;
      const scaled = Math.ceil(baseH * AUDIO_SCALE + 12);
      row.style.minHeight = scaled + 'px';
    }
  });
}

// Build an invite link with the current party code as URL parameter
function getJoinInputCode() {
  const inp = document.querySelector('input[name="code"]');
  const v = inp ? String(inp.value || '') : '';
  return v.trim().toUpperCase();
}

function buildInviteLink(codeOverride) {
  const code = (codeOverride || getJoinInputCode() || state?.code || my.code || '').toUpperCase();
  const origin = location.origin;
  const url = `${origin}/?pass=${encodeURIComponent(code)}`;
  return { code, url };
}

function updateInviteInput(prefix, codeOverride) {
  const input = document.getElementById(`invite-url-${prefix}`);
  if (!input) return;
  const { code, url } = buildInviteLink(codeOverride);
  input.value = code ? url : '';
  input.placeholder = code ? '' : 'Enter a code to generate an invite link';
  input.onclick = async () => {
    const latest = buildInviteLink(codeOverride || getJoinInputCode());
    input.value = latest.url;
    try { input.focus(); input.select(); await navigator.clipboard.writeText(latest.url); uiSuccess(); } catch {}
  };
}

async function initSSE() {
  if (evs) evs.close();
  evs = new EventSource(`/sse?code=${encodeURIComponent(my.code)}&playerId=${encodeURIComponent(my.id)}`);
  evs.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg.state; render(); }
  };
}


function render() {
  if (!state) return;
  $('#game-code').textContent = state.code;
  $('#player-name').textContent = (my.name || '').toUpperCase();
  const meFromState = state.players.find(p => p.id === my.id);
  const myAv = meFromState?.avatar || my.avatar || '🙂';
  const fav = document.getElementById('player-avatar'); if (fav) fav.textContent = myAv;

  // players list with scores + crown for top player(s)
  const ul = $('#players-list');
  ul.innerHTML = '';
  const r = state.currentRound;
  const replicateStatus = r?.replicateStatus || {};
  const votesStatus = r?.votesStatus || {};
  const scores = state.scores || {};
  let topScore = -Infinity; let hasAnyScore = false;
  for (const v of Object.values(scores)) { if (typeof v === 'number') { hasAnyScore = true; if (v > topScore) topScore = v; } }
  const topSet = new Set();
  if (hasAnyScore && isFinite(topScore) && topScore > 0) {
    for (const [pid, sc] of Object.entries(scores)) if (sc === topScore) topSet.add(pid);
  }
  for (const p of state.players) {
    const li = el('li', { class: 'player-row' });
    const av = el('span', { class: 'avatar' }, p.avatar || '🙂');
    const nameSpan = el('span', { class: 'player-name' }, (p.name || '').toUpperCase());
    li.appendChild(av);
    li.appendChild(nameSpan);
    // Crown for top scorer(s)
    if (topSet.has(p.id)) li.appendChild(el('span', { class: 'top-crown', title: 'Top score' }, '👑'));
    // Connection + phase status
    const sts = [];
    sts.push(p.connected ? '🟢' : '⚫');
    if (r) {
      if (r.state === 'replicate') sts.push(replicateStatus[p.id] ? 'submitted' : 'working');
      if (r.state === 'voting') sts.push(votesStatus[p.id] ? 'voted' : 'voting');
    }
    li.appendChild(el('span', { class: 'status' }, '• ' + sts.join(' • ')));
    // Score chip
    const sc = (typeof scores[p.id] === 'number') ? scores[p.id] : 0;
    li.appendChild(el('span', { class: 'score-chip', title: 'Score' }, `${sc} pts`));
    ul.appendChild(li);
  }

  if (!r) {
    // Pre-round lobby: show lobby panel and invite URL
    $('#phase').textContent = 'Lobby';
    show('#panel-lobby');
    updateInviteInput('lobby');
    adjustAudioRows();
    return;
  }
  // Reset crown only when the round index changes (new round)
  if (lastRoundIndex !== r.index) {
    lastRoundIndex = r.index;
    selectedCrown = null;
  }
  // Friendly phase name: call the final screen "Podium"
  $('#phase').textContent = (r.state === 'scoreboard') ? 'Podium' : r.state;

  // Panels
  const isLead = r.leadPlayerId === my.id;
  if (r.state === 'lead_record') {
    if (isLead) show('#panel-lead'); else show('#panel-wait-lead');
    // Update invite URL inputs for both lead/waiting views
    updateInviteInput('lead');
    updateInviteInput('wait');
  } else if (r.state === 'replicate') {
    // If I've already submitted, move me to the voting screen (waiting state); otherwise keep me on replicate.
    if (r.replicateStatus && r.replicateStatus[my.id]) {
      show('#panel-vote');
    } else {
      show('#panel-replicate');
    }
  } else if (r.state === 'voting') {
    if (votesStatus && votesStatus[my.id]) {
      show('#panel-wait-voting');
    } else {
      show('#panel-vote');
    }
  } else if (r.state === 'scoreboard') {
    show('#panel-scoreboard');
  }

  // Lead clip preload no longer required; server provides reversed WAV for compatibility

  // Voting UI setup + enable/disable depending on phase
  const voteBtn = $('#submit-votes');
  const skipBtn = $('#skip-vote');
  const voteWait = $('#vote-waiting');
  if (r.state === 'voting' && !(votesStatus && votesStatus[my.id])) {
    if (voteBtn) voteBtn.disabled = false;
    if (skipBtn) skipBtn.disabled = false;
    if (voteWait) voteWait.classList.add('hidden');
    setupVoting(r);
  } else if (r.state === 'voting' && (votesStatus && votesStatus[my.id])) {
    // Already voted: show waiting screen; ensure controls are disabled
    if (voteBtn) voteBtn.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    if (voteWait) voteWait.classList.add('hidden');
    const container = $('#vote-list'); if (container) container.innerHTML = '';
  } else if ((r.state === 'replicate') && (r.replicateStatus && r.replicateStatus[my.id])) {
    // Waiting state: user has submitted; show current submissions but disable voting
    if (voteBtn) voteBtn.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    if (voteWait) voteWait.classList.remove('hidden');
    setupVoting(r);
  } else {
    if (voteBtn) voteBtn.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    if (voteWait) voteWait.classList.add('hidden');
    const container = $('#vote-list'); if (container) container.innerHTML = '';
  }

  // Scores
  if (r.state === 'scoreboard') {
    const entries = Object.entries(state.scores).map(([pid, sc]) => ({ pid, score: sc }));
    entries.sort((a, b) => b.score - a.score);

    // Build podium
    const podium = $('#podium'); podium.innerHTML = '';
    const pmapName = Object.fromEntries(state.players.map(p => [p.id, p.name]));
    const pmapAvatar = Object.fromEntries(state.players.map(p => [p.id, p.avatar || '🙂']));
    const top1 = entries[0]; const top2 = entries[1];
    if (top1) {
      const tieFirst = top2 && top2.score === top1.score;
      const mkSlot = (rank, entry) => {
        const name = (pmapName[entry.pid] || 'Unknown').toUpperCase();
        const avatar = pmapAvatar[entry.pid];
        const slot = el('div', { class: 'slot' });
        const pillar = el('div', { class: 'pillar ' + (rank === 1 ? 'gold' : 'silver') });
        pillar.style.height = (rank === 1 ? 140 : 110) + 'px';
        const medal = el('div', { class: 'medal' }, rank === 1 ? '🥇' : '🥈');
        pillar.appendChild(medal);
        const av = el('span', { class: 'avatar avatar-lg avatar-podium' }, avatar);
        pillar.appendChild(av);
        slot.appendChild(pillar);
        slot.appendChild(el('div', { class: 'plaque' }, name));
        slot.appendChild(el('div', { class: 'score' }, `${entry.score} pts`));
        return slot;
      };
      if (tieFirst) {
        podium.appendChild(mkSlot(1, top1));
        podium.appendChild(mkSlot(1, top2));
      } else {
        podium.appendChild(mkSlot(1, top1));
        if (top2) podium.appendChild(mkSlot(2, top2));
      }
    }

    // Remove final score list; player list above already shows scores
    const grid = $('#scores-grid'); if (grid) { grid.innerHTML = ''; grid.classList.add('hidden'); }
    startCelebration();
  }
  // Ensure audio rows reserve enough space after panel changes
  adjustAudioRows();
}

function setupVoting(r) {
  const clips = r.voteClips || [];
  const container = $('#vote-list');
  container.innerHTML = '';
  clips.forEach((c, idx) => {
    const div = el('div', { class: 'clip' });
    div.appendChild(el('div', {}, `Clip #${idx + 1}`));
    // Dedicated native audio element for robust playback
    const audio = el('audio', { controls: true, playsinline: true, preload: 'metadata' });
    setAudioUrlWithType(audio, c.clipUrl);
    const btnR = el('button', { class: 'play-reversed btn-reverse' }, 'Play Reversed');
    const btnF = el('button', { class: 'play-forward' }, 'Play Forward');
    // Crown button
    const crown = el('button', { class: 'crown-btn', 'data-owner': c.ownerHiddenId }, '');
    crown.appendChild(el('span', { class: 'emoji' }, '👑'));
    crown.appendChild(document.createTextNode('Crown'));
    btnF.addEventListener('click', async () => {
      try {
        setAudioUrlWithType(audio, c.clipUrl);
        await audio.play();
      } catch (e) {
        console.error('Forward playback failed', e);
        alert('Unable to play this clip.');
      }
    });
    btnR.addEventListener('click', async () => {
      if (!c.revClipUrl) { alert('Reversed clip not ready yet. Try again.'); return; }
      try {
        setAudioUrlWithType(audio, c.revClipUrl);
        await audio.play();
      } catch (e) {
        console.error('Reverse playback failed', e);
        alert('Unable to play the reversed clip.');
      }
    });
    crown.addEventListener('click', () => {
      selectedCrown = c.ownerHiddenId;
      // Update visuals: only one crowned
      document.querySelectorAll('#vote-list .clip').forEach(elm => elm.classList.remove('crowned'));
      document.querySelectorAll('#vote-list .crown-btn').forEach(btn => btn.classList.remove('crown-active'));
      div.classList.add('crowned');
      crown.classList.add('crown-active');
      uiCrown();
    });
    const btnWrap = el('div', { class: 'clip-controls' });
    // Show Reversed first, then Forward
    btnWrap.appendChild(btnR);
    btnWrap.appendChild(btnF);
    div.appendChild(btnWrap);
    div.appendChild(crown);
    div.appendChild(audio);
    // Re-apply previous crown selection across re-renders
    if (selectedCrown && selectedCrown === c.ownerHiddenId) {
      div.classList.add('crowned');
      crown.classList.add('crown-active');
    }
    container.appendChild(div);
  });
}

function mimeFromUrl(u) {
  try {
    const ext = (new URL(u, location.href)).pathname.split('.').pop().toLowerCase();
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'webm') return 'audio/webm';
    if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
    if (ext === 'aac') return 'audio/aac';
    if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
  } catch {}
  return '';
}

function setAudioUrlWithType(audioEl, url) {
  while (audioEl.firstChild) audioEl.removeChild(audioEl.firstChild);
  const src = document.createElement('source');
  const type = mimeFromUrl(url);
  if (type) src.type = type;
  src.src = url;
  audioEl.appendChild(src);
  try { audioEl.load(); } catch {}
}

// Removed WebAudio decoding/reversal path; use server-provided files natively

// Timer display removed entirely
// Check context/support early and update UI hints
maybeWarnInsecureContext();
window.addEventListener('resize', adjustAudioRows);
window.addEventListener('orientationchange', adjustAudioRows);
attachButtonFX();

// Join form
$('#join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const code = fd.get('code').toString().trim().toUpperCase();
  const name = fd.get('name').toString().trim().toUpperCase();
  const avatar = fd.get('avatar') ? String(fd.get('avatar')) : '';
  const resp = await fetch('/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name, avatar }) });
  const data = await resp.json();
  my.code = data.code; my.id = data.playerId; my.name = name; my.avatar = avatar;
  state = data.state;
  $('#join-screen').classList.add('hidden');
  $('#game-screen').classList.remove('hidden');
  render();
  initSSE();
});

// Prefill join code from URL (?code=)
(function prefillFromURL() {
  try {
    const u = new URL(location.href);
    // Prefer pass=..., fallback to code=...
    const pass = u.searchParams.get('pass') || u.searchParams.get('code');
    if (pass) {
      const inp = document.querySelector('input[name="code"]');
      if (inp) inp.value = String(pass).toUpperCase();
    }
  } catch {}
  // Initialize join-screen invite URL with current input
  updateInviteInput('join');
  const inp = document.querySelector('input[name="code"]');
  if (inp) {
    const upd = () => { const up = getJoinInputCode(); updateInviteInput('join', up); };
    ['input','change','keyup','blur'].forEach(ev => inp.addEventListener(ev, upd));
    // In case autofill populates asynchronously, run a short debounce updater
    setTimeout(upd, 50);
    setTimeout(upd, 300);
    setTimeout(upd, 1000);
  }
})();

// Lead recording
// No-op stub retained (was previously used by MediaRecorder path)
function pickPreferredMime() { return 'audio/wav'; }

function setAudioBlob(audioId, sourceId, blob, mime) {
  const a = document.getElementById(audioId);
  const s = document.getElementById(sourceId);
  if (!a) return;
  const url = URL.createObjectURL(blob);
  if (s) {
    if (mime) s.type = mime;
    s.src = url;
    try { a.load(); } catch {}
  } else {
    a.src = url;
  }
}

// UI FX: ripples + sounds
function attachButtonFX() {
  document.querySelectorAll('button').forEach(btn => {
    if (!btn.querySelector('.ripple')) {
      const r = document.createElement('span'); r.className = 'ripple'; btn.appendChild(r);
    }
    btn.addEventListener('click', (ev) => {
      const r = btn.querySelector('.ripple'); if (!r) return;
      const rect = btn.getBoundingClientRect();
      const x = ev.clientX - rect.left; const y = ev.clientY - rect.top;
      r.style.setProperty('--x', x + 'px'); r.style.setProperty('--y', y + 'px');
      r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
      if (!shouldSilentClick(btn)) uiClick();
    });
  });
}

function shouldSilentClick(btn) {
  return btn.matches('#play-forward, #play-backward, .play-forward, .play-reversed, #lead-rec-btn, #lead-stop-btn, #rep-rec-btn, #rep-stop-btn');
}

async function ensureSound() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state !== 'running') { try { await audioCtx.resume(); } catch {} }
  return audioCtx;
}

function tone(freq, durMs, type='sine', gain=0.15, attack=0.005, release=0.08) {
  ensureSound();
  const t0 = audioCtx.currentTime;
  const o = audioCtx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
  const g = audioCtx.createGain(); g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs/1000 + release);
  o.connect(g).connect(audioCtx.destination);
  o.start(t0); o.stop(t0 + durMs/1000 + release + 0.02);
}

function uiClick(){ tone(600, 60, 'square', 0.08); }
function uiSuccess(){ tone(880, 100, 'sine', 0.12); setTimeout(()=>tone(1320, 120, 'sine', 0.1), 90); haptic('success'); }
function uiError(){ tone(220, 160, 'sawtooth', 0.12); setTimeout(()=>tone(160, 140, 'sawtooth', 0.1), 120); haptic('error'); }
function uiStartRecord(){ tone(520, 80, 'triangle', 0.12); haptic('light'); }
function uiStopRecord(){ tone(340, 80, 'triangle', 0.12); }
function uiCrown(){ tone(1040, 80, 'square', 0.12); setTimeout(()=>tone(1560, 100, 'square', 0.1), 80); haptic('success'); }

function createPcmWavRecorder(stream) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audioCtx;
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const gain = ctx.createGain(); gain.gain.value = 0; // avoid feedback
  let recording = false;
  const chunks = [];
  proc.onaudioprocess = (e) => {
    if (!recording) return;
    const ch0 = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(ch0));
  };
  source.connect(proc);
  proc.connect(gain);
  gain.connect(ctx.destination);
  const rec = {
    state: 'inactive',
    onstop: null,
    start() { recording = true; this.state = 'recording'; },
    stop() {
      if (!recording) return;
      recording = false; this.state = 'inactive';
      try {
        source.disconnect(); proc.disconnect(); gain.disconnect();
      } catch {}
      const sampleRate = ctx.sampleRate;
      const length = chunks.reduce((a, b) => a + b.length, 0);
      const merged = new Float32Array(length);
      let offset = 0; for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      const wav = encodeWavMonoPCM16(merged, sampleRate);
      const blob = new Blob([wav], { type: 'audio/wav' });
      if (typeof this.onstop === 'function') this.onstop(blob);
    }
  };
  return rec;
}

function encodeWavMonoPCM16(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = 1 * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, 'WAVE');
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, 1, true);  // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  // PCM data
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

async function startLeadRecording() {
  let stream;
  try {
    stream = await getMicStream();
  } catch (err) {
    alert('Unable to access microphone: ' + (err && err.message ? err.message : err));
    return;
  }
  const rec = createPcmWavRecorder(stream);
  leadMedia.recorder = rec;
  rec.onstop = (blob) => {
    leadMedia.lastBlob = blob;
    setAudioBlob('lead-play', 'lead-play-src', blob, 'audio/wav');
    $('#lead-upload-btn').disabled = false;
    adjustAudioRows();
  };
  rec.start();
  setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 5000);
}

$('#lead-rec-btn').addEventListener('click', () => {
  startLeadRecording();
  uiStartRecord();
  $('#lead-rec-btn').disabled = true;
  $('#lead-stop-btn').disabled = false;
});
$('#lead-stop-btn').addEventListener('click', () => {
  if (leadMedia.recorder && leadMedia.recorder.state === 'recording') leadMedia.recorder.stop();
  uiStopRecord();
  $('#lead-rec-btn').disabled = false;
  $('#lead-stop-btn').disabled = true;
});
$('#lead-upload-btn').addEventListener('click', async () => {
  if (!leadMedia.lastBlob) return;
  await fetch(`/upload/lead?code=${encodeURIComponent(my.code)}&playerId=${encodeURIComponent(my.id)}`, { method: 'POST', body: leadMedia.lastBlob });
  $('#lead-upload-btn').disabled = true;
  uiSuccess();
});

// Replicate phase
$('#play-forward').addEventListener('click', async () => {
  const url = state?.currentRound?.leadClipUrl;
  if (!url) return;
  const el = $('#lead-clip-player');
  setAudioUrlWithType(el, url);
  try { await el.play(); } catch {}
});
$('#play-backward').addEventListener('click', async () => {
  const url = state?.currentRound?.leadClipRevUrl;
  if (!url) { alert('Processing clip… try again in a moment.'); return; }
  const el = $('#lead-clip-player');
  setAudioUrlWithType(el, url);
  try { await el.play(); } catch {}
});

async function startRepRecording() {
  let stream;
  try {
    stream = await getMicStream();
  } catch (err) {
    alert('Unable to access microphone: ' + (err && err.message ? err.message : err));
    return;
  }
  const rec = createPcmWavRecorder(stream);
  repMedia.recorder = rec;
  rec.onstop = (blob) => {
    repMedia.lastBlob = blob;
    setAudioBlob('rep-play', 'rep-play-src', blob, 'audio/wav');
    $('#rep-upload-btn').disabled = false;
    adjustAudioRows();
  };
  rec.start();
  setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 5000);
}

$('#rep-rec-btn').addEventListener('click', () => {
  startRepRecording();
  uiStartRecord();
  $('#rep-rec-btn').disabled = true;
  $('#rep-stop-btn').disabled = false;
});
$('#rep-stop-btn').addEventListener('click', () => {
  if (repMedia.recorder && repMedia.recorder.state === 'recording') repMedia.recorder.stop();
  uiStopRecord();
  $('#rep-rec-btn').disabled = false;
  $('#rep-stop-btn').disabled = true;
});
$('#rep-upload-btn').addEventListener('click', async () => {
  if (!repMedia.lastBlob) return;
  await uploadReplication(repMedia.lastBlob);
  uiSuccess();
});

async function uploadReplication(blob) {
  await fetch(`/upload/replicate?code=${encodeURIComponent(my.code)}&playerId=${encodeURIComponent(my.id)}`, { method: 'POST', body: blob });
  $('#rep-upload-btn').disabled = true;
}

async function waitForScoreboard() {
  for (let i = 0; i < 20; i++) {
    try {
      const resp = await fetch(`/state?code=${encodeURIComponent(my.code)}&playerId=${encodeURIComponent(my.id)}`);
      const data = await resp.json();
      if (data?.currentRound?.state === 'scoreboard') {
        state = data;
        render();
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  show('#panel-wait-voting');
}

$('#submit-votes').addEventListener('click', async () => {
  if (!state?.currentRound || state.currentRound.state !== 'voting') return;
  if (!selectedCrown) {
    if (!confirm('No clip crowned. Submit as abstain?')) return;
    const btn = $('#submit-votes'); if (btn) btn.disabled = true;
    const resp = await fetch('/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: my.code, playerId: my.id, first: null, second: null }) });
    const data = await resp.json().catch(() => ({}));
    if (data && data.done) { uiSuccess(); await waitForScoreboard(); } else { uiSuccess(); show('#panel-wait-voting'); }
    return;
  }
  const btn = $('#submit-votes'); if (btn) btn.disabled = true;
  const resp = await fetch('/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: my.code, playerId: my.id, first: selectedCrown, second: null }) });
  const data = await resp.json().catch(() => ({}));
  if (data && data.done) { uiSuccess(); await waitForScoreboard(); } else { uiSuccess(); show('#panel-wait-voting'); }
});

$('#skip-vote').addEventListener('click', async () => {
  if (!state?.currentRound || state.currentRound.state !== 'voting') return;
  if (!confirm('Skip voting and abstain?')) return;
  const voteBtn = $('#submit-votes');
  const skipBtn = $('#skip-vote');
  if (voteBtn) voteBtn.disabled = true;
  if (skipBtn) skipBtn.disabled = true;
  const resp = await fetch('/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: my.code, playerId: my.id, first: null, second: null })
  });
  const data = await resp.json().catch(() => ({}));
  if (data && data.done) { uiClick(); await waitForScoreboard(); } else { uiClick(); show('#panel-wait-voting'); }
});

$('#next-round-btn').addEventListener('click', async () => {
  await fetch('/control/start_next_round', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: my.code }) });
  uiClick();
});

// Scoreboard celebration
function startCelebration() {
  if (document.querySelector('.confetti')) return;
  const root = document.body;
  const frags = [];
  const n = 90;
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    const r = Math.random();
    c.className = 'confetti' + (r < 0.33 ? ' tri' : r < 0.66 ? ' circle' : '');
    c.style.left = Math.random() * 100 + 'vw';
    const hue = Math.floor(Math.random()*360);
    c.style.background = `hsl(${hue},70%,60%)`;
    c.style.color = `hsl(${(hue+180)%360},70%,60%)`;
    c.style.animationDuration = (2 + Math.random() * 2.5).toFixed(2) + 's';
    c.style.animationDelay = (Math.random() * 0.2).toFixed(2) + 's';
    c.style.transform = `translateY(0) rotate(${Math.floor(Math.random()*180)}deg)`;
    root.appendChild(c);
    frags.push(c);
  }
  playFanfare();
  haptic('celebrate');
  setTimeout(() => frags.forEach(n => n.remove()), 4200);
}

function playFanfare() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g).connect(audioCtx.destination);
    o.type = 'triangle';
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.frequency.setValueAtTime(440, t);
    o.frequency.setValueAtTime(660, t + 0.2);
    o.frequency.setValueAtTime(880, t + 0.4);
    o.start(t);
    o.stop(t + 0.75);
  } catch {}
}

// Haptics helper (graceful fallback)
function haptic(kind='light') {
  if (!('vibrate' in navigator)) return;
  try {
    if (kind === 'celebrate') navigator.vibrate([10, 30, 10, 30, 10]);
    else if (kind === 'success') navigator.vibrate([12, 20]);
    else if (kind === 'error') navigator.vibrate([30, 50, 30]);
    else navigator.vibrate(15);
  } catch {}
}
