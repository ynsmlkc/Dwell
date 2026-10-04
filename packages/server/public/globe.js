/* Noktali dunya kuresi — ana sayfadaki "nerede kazaniliyor" haritasi.
 *
 * Kutuphane YOK: tek ihtiyac ortografik izdusum ve bunu 2D canvas'ta elle
 * yapmak, three.js / d3 indirmekten (yuzlerce KB) cok daha ucuz. Kara
 * noktalari ve ulke merkezleri `globe-data.js`'te hazir; burada yalnizca
 * cizim ve surukleme var.
 *
 * Kurede ADRES ya da KISI yok, yalnizca ulke basina toplam: sunucu da
 * yalnizca siralamada gorunmeyi secmis yayincilari sayiyor. */

import { LAND, COUNTRIES } from '/globe-data.js';

const RAD = Math.PI / 180;
const ACCENT = [245, 140, 60];      // --accent'in canvas karsiligi (oklch canvas'ta her yerde yok)
const ACCENT_HI = [255, 196, 120];
const MAX_TILT = 60 * RAD;
const AUTO_SPIN = 0.07;             // rad/sn, bosta donus (bati → dogu, Dunya gibi)
const MAX_FLING = 3;                // rad/sn
const IDLE_MS = 2500;               // surukleme bittikten sonra otomatik donusun baslamasi

/* Kara noktalari bir kez acilir: enlemin sin/cos'u sabit, kare basina
   yalnizca boylam farki hesaplaniyor. */
const N = LAND.length / 2;
const SIN_LAT = new Float32Array(N), COS_LAT = new Float32Array(N), LON = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const lat = (LAND[2 * i] / 10) * RAD;
  SIN_LAT[i] = Math.sin(lat); COS_LAT[i] = Math.cos(lat); LON[i] = (LAND[2 * i + 1] / 10) * RAD;
}

const clampV = (v) => Math.max(-MAX_FLING, Math.min(MAX_FLING, v));
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onHover?: (c: null | {code:string,name:string,devs:number,x:number,y:number}) => void,
 *           onSelect?: (code: string) => void }} [opts]
 */
export function mountGlobe(canvas, { onHover = () => {}, onSelect = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, dpr = 1, R = 0, cx = 0, cy = 0;
  let center = 30 * RAD, tilt = 22 * RAD;   // bakis: Avrupa/Afrika/Bati Asya
  let vLon = 0, vLat = 0;
  let lights = [];                          // { code, name, devs, sinLat, cosLat, lon, phase }
  let hovered = null;
  let lastInput = -Infinity;
  let running = false, raf = 0, prevT = 0;
  let stars = [];

  /* ── boyut ── */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    R = Math.min(W, H) * 0.4; cx = W / 2; cy = H / 2;
    // Yildizlar her boyutta yeniden serpilir; tohumlu, her yuklemede ayni.
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    stars = Array.from({ length: Math.round((W * H) / 9000) }, () => ({ x: rnd() * W, y: rnd() * H, a: 0.08 + rnd() * 0.3 }));
    draw(performance.now());
  }

  /* ── izdusum ── */
  const sinT = () => Math.sin(tilt), cosT = () => Math.cos(tilt);
  /** Kure uzerindeki noktayi ekrana dusurur; `z <= 0` arka yuzde. */
  function project(sinLat, cosLat, lon, st, ct) {
    const d = lon - center;
    const x = cosLat * Math.sin(d), y = sinLat, z = cosLat * Math.cos(d);
    return { x: cx + R * x, y: cy - R * (y * ct - z * st), z: y * st + z * ct };
  }

  /* ── cizim ── */
  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (const s of stars) {
      const dx = s.x - cx, dy = s.y - cy;
      if (dx * dx + dy * dy < (R + 12) * (R + 12)) continue;
      ctx.fillStyle = `rgba(236,231,225,${s.a})`;
      ctx.fillRect(s.x, s.y, 1, 1);
    }

    // Dis hale + kure govdesi + kenar isigi.
    const halo = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.22);
    halo.addColorStop(0, 'rgba(236,231,225,0.10)'); halo.addColorStop(1, 'rgba(236,231,225,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.22, 0, Math.PI * 2); ctx.fill();

    const body = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
    body.addColorStop(0, '#12100e'); body.addColorStop(1, '#050404');
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.shadowColor = 'rgba(236,231,225,0.55)'; ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(236,231,225,0.55)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // Kara noktalari — derinlige gore 4 parlaklik kovasi; her nokta icin
    // fillStyle degistirmek kare suresini ikiye katliyordu.
    const st = sinT(), ct = cosT();
    const size = Math.max(1.2, R / 190);
    const buckets = [[], [], [], []];
    for (let i = 0; i < N; i++) {
      const p = project(SIN_LAT[i], COS_LAT[i], LON[i], st, ct);
      if (p.z <= 0.02) continue;
      buckets[Math.min(3, (p.z * 4) | 0)].push(p.x, p.y);
    }
    buckets.forEach((b, k) => {
      ctx.fillStyle = `rgba(157,170,190,${0.16 + k * 0.15})`;
      for (let j = 0; j < b.length; j += 2) ctx.fillRect(b[j] - size / 2, b[j + 1] - size / 2, size, size);
    });

    // Isiklar — bir ulkede ne kadar cok gelistirici varsa o kadar genis.
    for (const l of lights) {
      const p = project(l.sinLat, l.cosLat, l.lon, st, ct);
      l.screen = p.z > 0.05 ? p : null;
      if (!l.screen) continue;
      const pulse = reduce ? 1 : 0.8 + 0.2 * Math.sin(t / 700 + l.phase);
      const r = (2.2 + 1.6 * Math.log2(1 + l.devs)) * (0.55 + 0.45 * p.z) * Math.max(1, R / 260);
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
      glow.addColorStop(0, rgba(ACCENT, 0.55 * pulse * p.z));
      glow.addColorStop(1, rgba(ACCENT, 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, r * 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(l === hovered ? [255, 255, 255] : ACCENT_HI, 0.95);
      ctx.beginPath(); ctx.arc(p.x, p.y, r * (l === hovered ? 1.35 : 1), 0, Math.PI * 2); ctx.fill();
    }
  }

  /* ── dongu ── */
  function frame(t) {
    const dt = Math.min(0.05, (t - (prevT || t)) / 1000);
    prevT = t;
    if (!dragging) {
      center += vLon * dt; tilt = clampTilt(tilt + vLat * dt);
      vLon *= Math.pow(0.04, dt); vLat *= Math.pow(0.04, dt);       // atalet sonumu
      if (!reduce && t - lastInput > IDLE_MS) vLon += (-AUTO_SPIN - vLon) * Math.min(1, dt * 1.5);
    }
    draw(t);
    if (running) raf = requestAnimationFrame(frame);
  }
  const clampTilt = (v) => Math.max(-MAX_TILT, Math.min(MAX_TILT, v));

  function start() {
    if (running) return;
    running = true; prevT = 0; raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // Ekranda degilken hic cizme — sayfanin geri kalaninda CPU yakmasin.
  new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(canvas);
  new ResizeObserver(resize).observe(canvas);

  /* ── surukleme ── */
  let dragging = false, lastX = 0, lastY = 0, lastMoveT = 0, moved = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; lastMoveT = performance.now();
    vLon = vLat = 0; lastInput = lastMoveT;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) { hover(e); return; }
    const now = performance.now(), dt = Math.max(1, now - lastMoveT) / 1000;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    center -= dx / R; tilt = clampTilt(tilt + dy / R);
    // Savrulma hizi sinirli: hizli bir fiske kureyi okyanusa firlatmasin.
    vLon = clampV(-dx / R / dt); vLat = clampV(dy / R / dt);
    lastX = e.clientX; lastY = e.clientY; lastMoveT = now; lastInput = now;
    if (!running) draw(now);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false; canvas.style.cursor = '';
    // Parmak durduktan sonra birakildiysa savrulma yok.
    if (performance.now() - lastMoveT > 80) vLon = vLat = 0;
    if (moved < 4 && hovered) onSelect(hovered.code);
    hover(e);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!dragging) setHovered(null); });

  function hover(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bestD = 14 * 14;
    for (const l of lights) {
      if (!l.screen) continue;
      const d = (l.screen.x - x) ** 2 + (l.screen.y - y) ** 2;
      if (d < bestD) { best = l; bestD = d; }
    }
    setHovered(best);
  }
  function setHovered(l) {
    hovered = l;
    canvas.style.cursor = dragging ? 'grabbing' : l ? 'pointer' : 'grab';
    onHover(l && l.screen ? { code: l.code, name: l.name, devs: l.devs, x: l.screen.x, y: l.screen.y } : null);
    if (!running) draw(performance.now());
  }

  /* ── klavye: ok tuslari kureyi dondurur ── */
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    const step = 12 * RAD;
    if (e.key === 'ArrowLeft') center -= step;
    else if (e.key === 'ArrowRight') center += step;
    else if (e.key === 'ArrowUp') tilt = clampTilt(tilt + step);
    else if (e.key === 'ArrowDown') tilt = clampTilt(tilt - step);
    else return;
    e.preventDefault(); lastInput = performance.now();
    if (!running) draw(lastInput);
  });

  return {
    /** @param {{country:string, devs:number}[]} list */
    setLights(list) {
      lights = list.filter((c) => COUNTRIES[c.country]).map((c, i) => {
        const [lat, lon, name] = COUNTRIES[c.country];
        return { code: c.country, name, devs: c.devs, sinLat: Math.sin(lat * RAD), cosLat: Math.cos(lat * RAD), lon: lon * RAD, phase: i * 1.7, screen: null };
      });
      // Ilk acilista en kalabalik ulke one gelsin.
      if (lights[0]) { center = lights[0].lon; tilt = clampTilt(Math.asin(lights[0].sinLat) * 0.6); }
      draw(performance.now());
    },
  };
}

/** "TR" → 🇹🇷. Bayrak emojisi olmayan sistemde iki harf olarak gorunur. */
export const flag = (code) =>
  code ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';

export const countryName = (code) => (code && COUNTRIES[code] ? COUNTRIES[code][2] : code || '');
export const countryCodes = () => Object.keys(COUNTRIES).sort((a, b) => COUNTRIES[a][2].localeCompare(COUNTRIES[b][2]));
