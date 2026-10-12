/* ==========================================================================
   Handlink — 2-device hand-tracking template (static, no backend)
   PLAYER device: camera + MediaPipe Hands  --PeerJS DataChannel-->  VIEWER device: Three.js cursor (+ optional game)

   Sections:
     0. CONFIG
     1. Helpers / screens
     2. initPeerConnection()      (both roles)
     3. startHandTracking()       (player)  + sendTrackingData()
     4. Viewer: 3D scene + render3DHandCursor()
     5. Interaction hooks         <-- put your own logic here
     6. GameBridge                (drives an iframe game with synthetic pointer events)
     7. Wiring
   ========================================================================== */
(() => {
'use strict';

/* ======================= 0. CONFIG ======================= */
const CONFIG = {
  // Path to the game that should appear on the Viewer after connecting.
  // Must be on the SAME origin. On GitHub Pages, all repos under ymgenv.github.io share one origin,
  // so '/ym/' works as long as Handlink is also hosted on ymgenv.github.io.
  // Set to '' to run the plain AR template (camera backdrop + 3D cursor + demo cube).
  GAME_URL: '/ym/',

  // How hand events are sent into the game: 'auto' (pointer + mouse), 'pointer', 'mouse' or 'touch'.
  GAME_INPUT: 'auto',
  // Pinch-and-release without moving more than this many px counts as a click on buttons/labels.
  CLICK_MOVE_TOLERANCE_PX: 16,
  // Elements a pinch-click is allowed to .click(). Add your own ids/classes.
  CLICKABLE: 'button, a[href], label, input, select, [role="button"], [onclick], #resetBtn, #exitBtn',

  CODE_LENGTH: 6,
  PEER_PREFIX: 'hlk-',          // namespaces codes on the free public PeerJS broker

  SEND_HZ: 30,                  // max tracking packets per second
  PINCH_ON: 0.30,               // thumb-index distance / palm size below this = pinch
  PINCH_OFF: 0.45,              // above this = released (hysteresis stops flicker)
  VIEWER_LERP: 0.28,            // 0..1, cursor smoothing on the viewer (higher = snappier)
  HAND_TIMEOUT_MS: 500,         // no packet for this long = hand lost

  // STUN is enough on most Wi-Fi. If devices are on different mobile networks and
  // connecting fails, add a TURN server here (e.g. from metered.ca or Twilio).
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // { urls: 'turn:YOUR_TURN_HOST:3478', username: 'user', credential: 'pass' }
  ],
  MP_HANDS_BASE: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/'
};
const HAS_GAME = !!CONFIG.GAME_URL;

/* ======================= 1. HELPERS ======================= */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r4 = v => Math.round(v * 10000) / 10000;

let toastTimer;
function toast(msg, ms = 3400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
}
function setStatus(dotId, textId, state, text) {
  $(dotId).className = 'dot ' + state;
  $(textId).textContent = text;
}
function generateCode() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % Math.pow(10, CONFIG.CODE_LENGTH)).padStart(CONFIG.CODE_LENGTH, '0');
}
const peerOptions = () => ({ config: { iceServers: CONFIG.ICE_SERVERS } });

/* ======================= 2. PEER CONNECTION ======================= */
const player = {
  peer: null, conn: null, hands: null, camera: null,
  facing: 'user', mirror: true, pinching: false, smooth: null,
  lastSend: 0, lastSentPinch: null, lastSentPresent: null, frames: 0, wake: null
};
const viewer = {
  peer: null, conn: null, ready: false, handPresent: false, data: null,
  pinchActive: false, lastPacket: 0, packets: 0, camStream: null
};

/**
 * initPeerConnection(role, code)
 *  - 'player': registers a short random code as the PeerJS id and waits for the viewer.
 *  - 'viewer': connects to the player that owns `code`.
 */
function initPeerConnection(role, code) {
  if (typeof Peer === 'undefined') { toast('PeerJS failed to load. Check your connection.'); return; }
  if (role === 'player') createPlayerPeer(0);
  else connectViewerToPlayer(code);
}

function createPlayerPeer(attempt) {
  const code = generateCode();
  const peer = new Peer(CONFIG.PEER_PREFIX + code, peerOptions());
  player.peer = peer;

  peer.on('open', () => {
    if (player.peer !== peer) return;
    $('playerCode').textContent = code.slice(0, 3) + ' ' + code.slice(3);
    setStatus('playerDot', 'playerStatus', 'wait', 'Waiting for the viewer…');
  });
  peer.on('connection', conn => {
    if (player.peer !== peer) return;
    if (player.conn && player.conn.open) player.conn.close();   // one viewer at a time
    player.conn = conn;
    conn.on('open', () => {
      setStatus('playerDot', 'playerStatus', 'ok', 'Viewer connected');
      player.lastSentPinch = player.lastSentPresent = null;
    });
    conn.on('close', () => {
      if (player.conn === conn) setStatus('playerDot', 'playerStatus', 'wait', 'Viewer left. Waiting…');
    });
    conn.on('error', e => toast('Link error: ' + (e.type || e)));
  });
  peer.on('disconnected', () => { if (player.peer === peer && !peer.destroyed) peer.reconnect(); });
  peer.on('error', err => {
    if (player.peer !== peer) return;
    if (err.type === 'unavailable-id' && attempt < 5) { peer.destroy(); createPlayerPeer(attempt + 1); return; }
    setStatus('playerDot', 'playerStatus', 'err', 'Connection error: ' + err.type);
  });
}

function connectViewerToPlayer(code) {
  closeViewerPeer();
  setStatus('viewerDot', 'viewerStatus', 'wait', 'Connecting…');
  const peer = new Peer(peerOptions());
  viewer.peer = peer;
  let timeout;

  const fail = msg => {
    clearTimeout(timeout);
    setStatus('viewerDot', 'viewerStatus', 'err', msg);
    if (viewer.peer === peer) closeViewerPeer();
  };

  peer.on('open', () => {
    const conn = peer.connect(CONFIG.PEER_PREFIX + code, { reliable: false, serialization: 'json' });
    viewer.conn = conn;
    timeout = setTimeout(() => fail('No answer. Check the code and try again.'), 12000);
    conn.on('open', () => { clearTimeout(timeout); enterViewerStage(); });
    conn.on('data', onTrackingData);
    conn.on('close', () => { if (viewer.conn === conn) onViewerDisconnected('The player disconnected.'); });
    conn.on('error', e => fail('Link error: ' + (e.type || e)));
  });
  peer.on('error', err => {
    fail(err.type === 'peer-unavailable' ? 'No player found with that code.' : 'Connection error: ' + err.type);
  });
}

function closeViewerPeer() {
  if (viewer.conn) { try { viewer.conn.close(); } catch (e) {} }
  if (viewer.peer) { try { viewer.peer.destroy(); } catch (e) {} }
  viewer.conn = viewer.peer = null;
}

/* ======================= 3. PLAYER: HAND TRACKING ======================= */
const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

async function startHandTracking() {
  if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
    toast('MediaPipe failed to load. Check your connection.'); return;
  }
  const video = $('playerVideo');
  if (!player.hands) {
    player.hands = new Hands({ locateFile: f => CONFIG.MP_HANDS_BASE + f });
    player.hands.setOptions({
      maxNumHands: 1, modelComplexity: 1,
      minDetectionConfidence: 0.6, minTrackingConfidence: 0.5
    });
    player.hands.onResults(onHandResults);
  }
  if (player.camera) { try { await player.camera.stop(); } catch (e) {} }

  player.mirror = player.facing === 'user';
  $('playerFeed').classList.toggle('mirrored', player.mirror);
  player.smooth = null;

  player.camera = new Camera(video, {
    onFrame: async () => { await player.hands.send({ image: video }); },
    facingMode: player.facing, width: 640, height: 480
  });
  try {
    await player.camera.start();
  } catch (e) {
    toast('Camera blocked. Allow camera access and reload.');
    return;
  }
  try { if (navigator.wakeLock) player.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
}

function onHandResults(results) {
  player.frames++;
  const video = $('playerVideo');
  const lm = results.multiHandLandmarks && results.multiHandLandmarks[0];
  if (!lm) {
    drawHand(null);
    player.pinching = false;
    player.smooth = null;
    $('playerReadout').textContent = 'no hand';
    $('playerPinch').classList.remove('on');
    sendTrackingData({ t: Date.now(), present: false, pinching: false, gesture: 'none' });
    return;
  }
  const data = computeHandData(lm, video);
  drawHand(lm, data);
  $('playerReadout').textContent =
    `x ${data.x.toFixed(2)} y ${data.y.toFixed(2)} z ${data.z.toFixed(2)} · ${data.gesture}`;
  $('playerPinch').classList.toggle('on', data.pinching);
  sendTrackingData(data);
}

function computeHandData(lm, video) {
  const asp = (video.videoWidth || 640) / (video.videoHeight || 480);
  const d2 = (a, b) => Math.hypot((a.x - b.x) * asp, a.y - b.y);

  const palm = d2(lm[0], lm[9]) || 1e-4;           // wrist -> middle knuckle = hand size
  const ratio = d2(lm[4], lm[8]) / palm;            // pinch distance relative to hand size

  if (!player.pinching && ratio < CONFIG.PINCH_ON) player.pinching = true;
  else if (player.pinching && ratio > CONFIG.PINCH_OFF) player.pinching = false;

  const mx = v => (player.mirror ? 1 - v : v);
  const index = { x: mx(lm[8].x), y: lm[8].y };
  const thumb = { x: mx(lm[4].x), y: lm[4].y };

  // Cursor sits between thumb and index: it stays put while the fingers close.
  const raw = {
    x: (index.x + thumb.x) / 2,
    y: (index.y + thumb.y) / 2,
    z: clamp((palm - 0.10) / 0.25, 0, 1)            // 0 = far from camera, 1 = close
  };
  // Adaptive smoothing: steady when slow, responsive when fast.
  if (!player.smooth) player.smooth = { ...raw };
  const s = player.smooth;
  const delta = Math.hypot(raw.x - s.x, raw.y - s.y);
  const a = clamp(0.25 + delta * 12, 0.25, 0.9);
  s.x += (raw.x - s.x) * a;
  s.y += (raw.y - s.y) * a;
  s.z += (raw.z - s.z) * 0.25;

  return {
    t: Date.now(), present: true,
    x: r4(s.x), y: r4(s.y), z: r4(s.z),
    index: { x: r4(index.x), y: r4(index.y) },
    thumb: { x: r4(thumb.x), y: r4(thumb.y) },
    pinchDist: r4(ratio),
    pinching: player.pinching,
    gesture: detectGesture(lm, player.pinching, d2)
  };
}

function detectGesture(lm, pinching, d2) {
  if (pinching) return 'pinch';
  const ext = (tip, pip) => d2(lm[tip], lm[0]) > d2(lm[pip], lm[0]) * 1.05;
  const f = [ext(8, 6), ext(12, 10), ext(16, 14), ext(20, 18)];
  const n = f.filter(Boolean).length;
  if (n === 0) return 'fist';
  if (f[0] && n === 1) return 'point';
  if (n >= 3) return 'open';
  return 'other';
}

/** Streams one tracking packet to the viewer (throttled; pinch changes always go out immediately). */
function sendTrackingData(data) {
  const conn = player.conn;
  if (!conn || !conn.open) return;
  const now = performance.now();
  const changed = data.pinching !== player.lastSentPinch || data.present !== player.lastSentPresent;
  const minGap = data.present ? 1000 / CONFIG.SEND_HZ : 250;   // slow keep-alive while no hand
  if (!changed && now - player.lastSend < minGap) return;
  conn.send(data);
  player.lastSend = now;
  player.lastSentPinch = data.pinching;
  player.lastSentPresent = data.present;
}

function drawHand(lm) {
  const c = $('playerOverlay'), ctx = c.getContext('2d'), v = $('playerVideo');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = c.clientWidth, ch = c.clientHeight;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
    c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!lm) return;

  // video uses object-fit: cover, so map landmarks the same way
  const vw = v.videoWidth || 640, vh = v.videoHeight || 480;
  const sc = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * sc) / 2, oy = (ch - vh * sc) / 2;
  const P = p => [p.x * vw * sc + ox, p.y * vh * sc + oy];
  const pinching = player.pinching;
  const col = pinching ? '#ffa23a' : '#5ee6d0';

  ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(94,230,208,.75)';
  ctx.shadowColor = col; ctx.shadowBlur = 8;
  HAND_CONNECTIONS.forEach(([a, b]) => {
    const [x1, y1] = P(lm[a]), [x2, y2] = P(lm[b]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  });
  ctx.shadowBlur = 0;
  lm.forEach((p, i) => {
    const [x, y] = P(p);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, i === 4 || i === 8 ? 7 : 3.5, 0, 6.2832); ctx.fill();
  });
  // pinch line + cursor point
  const [tx, ty] = P(lm[4]), [ix, iy] = P(lm[8]);
  ctx.strokeStyle = col; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ix, iy); ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc((tx + ix) / 2, (ty + iy) / 2, pinching ? 13 : 9, 0, 6.2832); ctx.fill();
}

setInterval(() => { $('playerFps').textContent = player.frames; player.frames = 0; }, 1000);

/* ======================= 4. VIEWER: 3D SCENE ======================= */
const CAM_Z = 6, FOV = 50;
const T = { renderer: null, scene: null, camera: null, cursor: null, clock: null, started: false };
// target = latest packet, cur = smoothed value actually drawn (normalised 0..1 screen coords)
const tgt = { nx: .5, ny: .5, depth: .5, pinching: false };
const cur = { nx: .5, ny: .5, depth: .5, pinch: 0, vis: 0 };

function initThree() {
  if (T.started) return;
  if (typeof THREE === 'undefined') { toast('Three.js failed to load.'); return; }
  T.started = true;
  T.renderer = new THREE.WebGLRenderer({ canvas: $('threeCanvas'), alpha: true, antialias: true });
  T.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  T.scene = new THREE.Scene();
  T.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  T.camera.position.z = CAM_Z;
  T.clock = new THREE.Clock();

  T.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(2, 3, 4); T.scene.add(dl);

  T.cursor = buildCursor();
  T.scene.add(T.cursor.group);

  /* >>> CUSTOM 3D OBJECTS: add your meshes to T.scene here.
         Example:
           const box = new THREE.Mesh(new THREE.BoxGeometry(.5,.5,.5), new THREE.MeshStandardMaterial({color:0x6e5cff}));
           T.scene.add(box);
         Keep references (e.g. T.box = box) so you can animate them in animate() below. */
  if (!HAS_GAME) Demo.init();

  onResize();
  window.addEventListener('resize', onResize);
  requestAnimationFrame(animate);
}

function onResize() {
  if (!T.renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  T.renderer.setSize(w, h, false);
  T.camera.aspect = w / h;
  T.camera.updateProjectionMatrix();
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(.35, 'rgba(255,255,255,.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function buildCursor() {
  const IDLE = new THREE.Color(0x5ee6d0), PINCH = new THREE.Color(0xffa23a);
  const group = new THREE.Group();
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.085, 24, 24), new THREE.MeshBasicMaterial({ color: IDLE }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.014, 16, 64), new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: .9 }));
  const tex = glowTexture();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: IDLE, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.set(1, 1, 1);
  group.add(core, ring, halo);

  // short fading trail
  const trail = [];
  for (let i = 0; i < 10; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: IDLE, transparent: true, opacity: .22 * (1 - i / 10), blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.setScalar(0.28 * (1 - i / 14));
    T.scene.add(s); trail.push(s);
  }
  return { group, core, ring, halo, trail, hist: [], IDLE, PINCH };
}

/**
 * render3DHandCursor(handData)
 * Called for every packet from the player. It only stores the new target; the animate() loop
 * does the lerp, so the cursor stays smooth even if packets arrive unevenly.
 * handData: { present, x, y, z, index:{x,y}, thumb:{x,y}, pinchDist, pinching, gesture }
 */
function render3DHandCursor(handData) {
  viewer.data = handData;
  viewer.handPresent = !!handData.present;
  if (!handData.present) return;
  tgt.nx = handData.x; tgt.ny = handData.y; tgt.depth = handData.z; tgt.pinching = !!handData.pinching;
  if (cur.vis === 0) { cur.nx = tgt.nx; cur.ny = tgt.ny; }   // appear exactly where the hand is
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(T.clock.getDelta(), 0.1), t = T.clock.elapsedTime;
  const now = performance.now();

  if (viewer.handPresent && now - viewer.lastPacket > CONFIG.HAND_TIMEOUT_MS) viewer.handPresent = false;

  // frame-rate independent lerp
  const k = 1 - Math.pow(1 - CONFIG.VIEWER_LERP, dt * 60);
  cur.nx += (tgt.nx - cur.nx) * k;
  cur.ny += (tgt.ny - cur.ny) * k;
  cur.depth += (tgt.depth - cur.depth) * k;
  cur.pinch += ((viewer.handPresent && tgt.pinching ? 1 : 0) - cur.pinch) * Math.min(1, dt * 14);
  cur.vis += ((viewer.handPresent ? 1 : 0) - cur.vis) * Math.min(1, dt * 10);
  if (cur.vis < 0.003 && !viewer.handPresent) cur.vis = 0;

  // screen position -> world position, computed at the cursor's own depth so it always
  // lands exactly under the (nx, ny) screen point; depth only changes its size.
  const wz = (cur.depth - 0.5) * 1.4;
  const halfH = Math.tan((FOV / 2) * Math.PI / 180) * (CAM_Z - wz);
  const aspect = T.camera.aspect;
  const c = T.cursor;
  c.group.position.set((cur.nx - 0.5) * 2 * halfH * aspect, (0.5 - cur.ny) * 2 * halfH, wz);

  // pinch feedback: colour shifts, ring tightens and pulses, halo brightens
  const pulse = cur.pinch > 0.5 ? 1 + 0.12 * Math.sin(t * 16) : 1;
  const col = c.IDLE.clone().lerp(c.PINCH, cur.pinch);
  c.core.material.color.copy(col); c.ring.material.color.copy(col); c.halo.material.color.copy(col);
  c.ring.scale.setScalar((1 - 0.45 * cur.pinch) * pulse);
  c.ring.rotation.z += dt * (1 + cur.pinch * 4);
  c.core.scale.setScalar(1 + 0.5 * cur.pinch);
  c.halo.scale.setScalar(0.9 + 0.7 * cur.pinch);
  c.halo.material.opacity = 0.4 + 0.4 * cur.pinch;
  c.group.scale.setScalar(cur.vis);
  c.group.visible = cur.vis > 0.01;

  c.hist.unshift(c.group.position.clone());
  if (c.hist.length > 24) c.hist.pop();
  c.trail.forEach((s, i) => {
    const p = c.hist[Math.min((i + 1) * 2, c.hist.length - 1)];
    if (p) s.position.copy(p);
    s.material.color.copy(col);
    s.visible = c.group.visible;
  });

  // --- interaction events use the SMOOTHED cursor so game input matches what you see ---
  const pos = { nx: cur.nx, ny: cur.ny, px: cur.nx * window.innerWidth, py: cur.ny * window.innerHeight, z: cur.depth };
  const want = viewer.handPresent && tgt.pinching;
  if (want && !viewer.pinchActive) { viewer.pinchActive = true; $('viewerPinch').classList.add('on'); Interaction.onPinchStart(pos); }
  else if (!want && viewer.pinchActive) { viewer.pinchActive = false; $('viewerPinch').classList.remove('on'); Interaction.onPinchEnd(pos); }
  else if (want) Interaction.onPinchMove(pos);

  /* >>> PER-FRAME UPDATES: animate your own objects here (dt = seconds, t = total seconds).
         cursor world position: T.cursor.group.position */
  if (!HAS_GAME) Demo.update(dt, t);

  T.renderer.render(T.scene, T.camera);
}

function onTrackingData(d) {
  if (!d || typeof d !== 'object') return;
  viewer.lastPacket = performance.now();
  viewer.packets++;
  render3DHandCursor(d);
}
setInterval(() => { $('viewerHz').textContent = viewer.packets; viewer.packets = 0; }, 1000);

/* ======================= 5. INTERACTION HOOKS ======================= */
/* All hand input arrives here. `pos` = { nx, ny (0..1), px, py (screen pixels), z (0 far .. 1 close) }.
   >>> CUSTOM INTERACTION LOGIC: edit these four functions.
       Ideas: raycast from the cursor into your scene (THREE.Raycaster), grab/drag objects,
       trigger UI when gesture === 'fist' (see viewer.data.gesture), etc. */
const Interaction = {
  onPinchStart(pos) { HAS_GAME ? GameBridge.down(pos.px, pos.py) : Demo.grab(); },
  onPinchMove(pos)  { if (HAS_GAME) GameBridge.move(pos.px, pos.py); },
  onPinchEnd(pos)   { HAS_GAME ? GameBridge.up(pos.px, pos.py) : Demo.release(); },
  onHandLost()      { if (viewer.pinchActive) { viewer.pinchActive = false; Interaction.onPinchEnd(cursorPos()); } }
};
function cursorPos() {
  return { nx: cur.nx, ny: cur.ny, px: cur.nx * innerWidth, py: cur.ny * innerHeight, z: cur.depth };
}

/* Tiny demo (only when GAME_URL is empty): pinch near the cube to pick it up. Delete freely. */
const Demo = {
  cube: null, held: false,
  init() {
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(.7, .7, .7), new THREE.MeshStandardMaterial({ color: 0x6e5cff, roughness: .35 }));
    this.cube.position.set(0, 0, 0);
    T.scene.add(this.cube);
  },
  grab() { if (this.cube && T.cursor.group.position.distanceTo(this.cube.position) < 0.9) this.held = true; },
  release() { this.held = false; },
  update(dt) {
    if (!this.cube) return;
    this.cube.rotation.x += dt * .6; this.cube.rotation.y += dt * .8;
    if (this.held) this.cube.position.lerp(T.cursor.group.position, 0.35);
    this.cube.material.emissive.setHex(this.held ? 0x331a00 : 0x000000);
  }
};

/* ======================= 6. GAME BRIDGE ======================= */
/* Loads your game in a same-origin iframe and feeds it the hand as a mouse/pointer:
   pinch = press, move while pinched = drag, release = let go. A short pinch on a button = click.
   The game needs no changes. */
const GameBridge = {
  frame: null, target: null, isDown: false, start: null, moved: 0, mounted: false,

  mount() {
    if (!HAS_GAME || this.mounted) return;
    this.frame = $('gameFrame');
    this.frame.hidden = false;
    this.frame.addEventListener('load', () => this.patchFrame());
    this.frame.src = CONFIG.GAME_URL;
    this.mounted = true;
  },
  unmount() {
    if (!this.mounted) return;
    this.frame.removeAttribute('src'); this.frame.hidden = true;
    this.mounted = false; this.isDown = false;
  },
  // Games often call canvas.setPointerCapture(e.pointerId). That throws for synthetic events
  // and would abort the game's handler, so make it a safe no-op inside the iframe.
  patchFrame() {
    try {
      const proto = this.frame.contentWindow.Element.prototype;
      ['setPointerCapture', 'releasePointerCapture'].forEach(m => {
        const orig = proto[m];
        proto[m] = function (id) { try { return orig.call(this, id); } catch (e) {} };
      });
    } catch (e) { toast('Game must be on the same origin as this page.'); }
  },
  doc() { try { return this.frame.contentDocument; } catch (e) { return null; } },

  down(x, y) {
    const doc = this.doc(); if (!doc) return;
    this.target = doc.elementFromPoint(x, y) || doc.body;
    this.isDown = true; this.start = { x, y }; this.moved = 0;
    this.fire('down', x, y);
  },
  move(x, y) {
    if (!this.isDown) return;
    this.moved = Math.max(this.moved, Math.hypot(x - this.start.x, y - this.start.y));
    this.fire('move', x, y);
  },
  up(x, y) {
    if (!this.isDown) return;
    this.fire('up', x, y);
    this.isDown = false;
    if (this.moved < CONFIG.CLICK_MOVE_TOLERANCE_PX && this.target && this.target.closest) {
      const el = this.target.closest(CONFIG.CLICKABLE);
      if (el) el.click();
    }
    this.target = null;
  },

  fire(kind, x, y) {
    const win = this.frame.contentWindow, el = this.target;
    if (!win || !el) return;
    const mode = CONFIG.GAME_INPUT, buttons = kind === 'up' ? 0 : 1;
    const base = { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, screenX: x, screenY: y };
    try {
      if (mode === 'pointer' || mode === 'auto') {
        el.dispatchEvent(new win.PointerEvent('pointer' + kind, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: kind === 'move' ? -1 : 0, buttons }));
      }
      if (mode === 'mouse' || mode === 'auto') {
        el.dispatchEvent(new win.MouseEvent('mouse' + kind, { ...base, button: 0, buttons }));
      }
      if (mode === 'touch') {
        const touch = new win.Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
        const live = kind === 'up' ? [] : [touch];
        const name = kind === 'down' ? 'touchstart' : kind === 'up' ? 'touchend' : 'touchmove';
        el.dispatchEvent(new win.TouchEvent(name, { bubbles: true, cancelable: true, view: win, touches: live, targetTouches: live, changedTouches: [touch] }));
      }
    } catch (e) { /* the game's own handler threw; keep streaming */ }
  }
};

/* ======================= 7. VIEWER FLOW + WIRING ======================= */
function enterViewerStage() {
  $('viewerConnect').hidden = true;
  $('viewerStage').hidden = false;
  initThree();
  onResize();
  GameBridge.mount();
  if (!HAS_GAME) { $('btnCamBg').hidden = false; setViewerCamera(true); }
}

function onViewerDisconnected(msg) {
  Interaction.onHandLost();
  viewer.handPresent = false;
  closeViewerPeer();
  setViewerCamera(false);
  $('viewerStage').hidden = true;
  $('viewerConnect').hidden = false;
  setStatus('viewerDot', 'viewerStatus', 'err', msg || 'Disconnected');
}

async function setViewerCamera(on) {
  const v = $('viewerVideo');
  if (on) {
    try {
      viewer.camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      v.srcObject = viewer.camStream; v.hidden = false;
    } catch (e) { toast('Could not open this device\'s camera.'); v.hidden = true; }
  } else {
    if (viewer.camStream) viewer.camStream.getTracks().forEach(tr => tr.stop());
    viewer.camStream = null; v.srcObject = null; v.hidden = true;
  }
}

function leaveToRoles() {
  if (player.camera) { try { player.camera.stop(); } catch (e) {} player.camera = null; }
  if (player.conn) { try { player.conn.close(); } catch (e) {} }
  if (player.peer) { try { player.peer.destroy(); } catch (e) {} }
  if (player.wake) { try { player.wake.release(); } catch (e) {} player.wake = null; }
  player.peer = player.conn = null; player.smooth = null; player.pinching = false;
  $('playerCode').textContent = '······';

  Interaction.onHandLost();
  closeViewerPeer();
  setViewerCamera(false);
  GameBridge.unmount();
  $('viewerStage').hidden = true;
  $('viewerConnect').hidden = false;
  setStatus('viewerDot', 'viewerStatus', '', 'Not connected');
  showScreen('role');
}

$('btnPlayer').addEventListener('click', async () => {
  showScreen('player');
  setStatus('playerDot', 'playerStatus', 'wait', 'Starting…');
  initPeerConnection('player');
  await startHandTracking();
});
$('btnViewer').addEventListener('click', () => { showScreen('viewer'); $('codeInput').focus(); });

$('btnFlip').addEventListener('click', async () => {
  player.facing = player.facing === 'user' ? 'environment' : 'user';
  await startHandTracking();
});
$('btnLeavePlayer').addEventListener('click', leaveToRoles);
$('btnLeaveViewer').addEventListener('click', leaveToRoles);
$('btnDisconnect').addEventListener('click', () => onViewerDisconnected('Disconnected.'));
$('btnCamBg').addEventListener('click', () => setViewerCamera(!viewer.camStream));

$('codeInput').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, CONFIG.CODE_LENGTH);
});
function submitCode() {
  const code = $('codeInput').value.trim();
  if (code.length !== CONFIG.CODE_LENGTH) { toast(`Enter the ${CONFIG.CODE_LENGTH}-digit code.`); return; }
  initPeerConnection('viewer', code);
}
$('btnConnect').addEventListener('click', submitCode);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitCode(); });

window.addEventListener('beforeunload', () => { closeViewerPeer(); if (player.peer) player.peer.destroy(); });
})();
