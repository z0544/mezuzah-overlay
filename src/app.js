// Mezuzah Overlay – WebXR (immersive-ar) for Meta Quest 3S
// All units in meters inside the XR scene; UI in centimeters.
import * as THREE from 'three';
import TEXT from './data/mezuzah-text.json';
import stamFontUrl from './fonts/StamAshkenazCLM.ttf';

{
  // ---------- constants ----------
  const STORE_KEY = 'mezuzah-overlay.settings.v1';
  const TIP_OFFSET = 0.012;          // m, along controller target ray
  const NUDGE = 0.0005;              // 0.5 mm
  const ROT_STEP = THREE.MathUtils.degToRad(0.1);
  const OPACITY_STEPS = [0.3, 0.5, 0.7, 0.9];
  const MODES = ['full', 'line', 'off'];
  const MODE_LABEL = { full: 'מלא', line: 'שורה נוכחית', off: 'מוסתר' };
  const TEX_MAX = 2048;
  const TEXT_SHA256 = 'a74a44b7c1fe7bb6d423ccada6ad47b33de902c7a0641ed88e8854a4304b0db4';
  const FONT_FAMILY = 'StamAshkenazCLM';
  const textState = { ready: false, error: '', hash: '', r: 0, userFont: null };

  // ---------- state ----------
  const S = {
    tpl: 'grid', w: 10, h: 10, rows: 22, letterPct: 60,
    color: '#ff2d55', opacity: 0.6, autoTrim: true,
    img: null,        // { mask: HTMLCanvasElement, aspect, hash, name }
    mode: 'full', line: 0, bigLetters: false,
    cal: 'klaf', mt: 4, mb: 4, mr: 6, ml: 3, // calibrate on klaf corners; margins in mm
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $('settings'), w: $('w'), h: $('h'), rows: $('rows'), letterPct: $('letterPct'),
    opacity: $('opacity'), opVal: $('opVal'), imgBox: $('imgBox'), imgFile: $('imgFile'),
    imgFileLbl: $('imgFileLbl'), imgHash: $('imgHash'), imgErr: $('imgErr'), autoTrim: $('autoTrim'),
    enter: $('enterAR'), enterHint: $('enterHint'), enterLbl: $('enterLbl'), arErr: $('arErr'), status: $('xrStatus'),
    statusText: $('xrStatusText'), canvas: $('previewCanvas'), stageEmpty: $('stageEmpty'),
    dimW: $('dimW'), dimH: $('dimH'), dimRows: $('dimRows'), sizeHint: $('sizeHint'),
  };

  // ---------- persistence (best effort) ----------
  function save() {
    try {
      const { tpl, w, h, rows, letterPct, color, opacity, autoTrim, bigLetters, cal, mt, mb, mr, ml } = S;
      localStorage.setItem(STORE_KEY, JSON.stringify({ tpl, w, h, rows, letterPct, color, opacity, autoTrim, bigLetters, cal, mt, mb, mr, ml }));
    } catch (_) { /* storage unavailable */ }
  }
  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!v || typeof v !== 'object') return;
      const num = (x, lo, hi, d) => (Number.isFinite(+x) && +x >= lo && +x <= hi ? +x : d);
      S.w = num(v.w, 3, 60, S.w); S.h = num(v.h, 3, 60, S.h);
      S.rows = Math.round(num(v.rows, 1, 60, S.rows)); S.letterPct = num(v.letterPct, 20, 90, S.letterPct);
      S.opacity = num(v.opacity, 0.1, 1, S.opacity);
      if (/^#[0-9a-f]{6}$/i.test(v.color)) S.color = v.color;
      S.autoTrim = v.autoTrim !== false; S.bigLetters = v.bigLetters === true;
      if (v.cal === 'block') S.cal = 'block';
      S.mt = num(v.mt, 0, 30, S.mt); S.mb = num(v.mb, 0, 30, S.mb); S.mr = num(v.mr, 0, 30, S.mr); S.ml = num(v.ml, 0, 30, S.ml);
      if (v.tpl === 'text') S.tpl = 'text'; // image is not persisted
    } catch (_) { /* ignore */ }
  }

  // ---------- geometry of rows (STaM: block top = first sirtut line, bottom = bottom of last row) ----------
  function rowGeom(Hpx) {
    const p = S.tpl === 'text' ? textSize().p : S.letterPct / 100;
    const rows = S.tpl === 'text' ? TEXT.lines.length : S.rows;
    const step = Hpx / ((rows - 1) + p);
    return { step, letter: step * p };
  }

  function rowCount() { return S.tpl === 'text' ? TEXT.lines.length : S.rows; }
  // S.w/S.h are the size of the calibrated rectangle: the klaf (cal=klaf) or the writing block (cal=block)
  const onKlaf = () => S.cal === 'klaf';
  const r2 = (v) => +v.toFixed(2);
  function blockW() { return r2(onKlaf() ? S.w - (S.mr + S.ml) / 10 : S.w); }
  function heightCm() { // writing-block height
    if (S.tpl === 'image' && S.img) return r2(blockW() * S.img.aspect);
    return r2(onKlaf() ? S.h - (S.mt + S.mb) / 10 : S.h);
  }
  function outerW() { return S.w; }
  function outerH() { return S.tpl === 'image' && S.img ? r2(heightCm() + (onKlaf() ? (S.mt + S.mb) / 10 : 0)) : S.h; }
  function blockOffset() { return onKlaf() ? { x: -S.mr / 1000, y: -S.mt / 1000 } : { x: 0, y: 0 }; } // meters, from top-right corner
  // text mode: letter size follows the width (longest line flush with one-yod spacing); returns p = letter/line-step
  // text mode: letter height comes from the rows (גובה אות %), letter width is scaled so the longest
  // line reaches the edge with one-yod spacing (STaM letters are wider than the font's)
  // text mode: letters keep the font's own proportions (no horizontal scaling, so stroke widths and angles
  // stay exactly as designed). Letter size is set by the width: the longest line, with one-yod spacing,
  // reaches the edge. The row spacing then follows from the height.
  function textSize() {
    const n = TEXT.lines.length - 1, Hb = heightCm();
    if (!textState.r) return { p: S.letterPct / 100, raw: S.letterPct / 100, mm: 0 };
    let body = textState.r * blockW(), step = (Hb - body) / n;
    const raw = body / step;
    let p = raw;
    if (raw > 0.85) { p = 0.85; step = Hb / (n + p); body = p * step; } // too tight: smaller letters, lines filled by dilation
    return { p, raw, mm: body * 10 };
  }

  // ---------- template drawing (shared by preview and XR texture) ----------
  function drawTemplate(ctx, Wpx, Hpx, { mode = 'full', line = -1 } = {}) {
    ctx.clearRect(0, 0, Wpx, Hpx);
    if (mode === 'off') return;
    const { step, letter } = rowGeom(Hpx);
    const lw = Math.max(1.5, Wpx / 700);
    const focus = mode === 'line' && line >= 0;
    const dim = 0.18;

    if (S.tpl === 'text' && textState.ready) {
      const n = TEXT.lines.length;
      // faint sirtut lines
      ctx.strokeStyle = S.color; ctx.lineWidth = Math.max(1, lw * 0.7);
      for (let i = 0; i < n; i++) {
        ctx.globalAlpha = focus ? (i === line ? 0.6 : 0.08) : 0.28;
        ctx.beginPath(); ctx.moveTo(0, i * step + 0.5); ctx.lineTo(Wpx, i * step + 0.5); ctx.stroke();
      }
      ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, Hpx); ctx.moveTo(Wpx - 0.5, 0); ctx.lineTo(Wpx - 0.5, Hpx); ctx.stroke();
      const tint = tintCanvas(textMask(Wpx, Hpx), S.color);
      ctx.globalAlpha = focus ? dim : 1;
      ctx.drawImage(tint, 0, 0);
      if (focus) {
        ctx.globalAlpha = 1;
        const y0 = Math.max(0, line * step - step * 0.25), y1 = Math.min(Hpx, line * step + letter + step * 0.3);
        ctx.save(); ctx.beginPath(); ctx.rect(0, y0, Wpx, y1 - y0); ctx.clip(); ctx.drawImage(tint, 0, 0); ctx.restore();
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (S.tpl === 'image' && S.img) {
      // tinted mask
      const tint = tintCanvas(S.img.mask, S.color);
      ctx.globalAlpha = focus ? dim : 1;
      ctx.drawImage(tint, 0, 0, Wpx, Hpx);
      ctx.globalAlpha = 1;
      if (focus) {
        const y0 = Math.max(0, line * step - step * 0.15);
        const y1 = Math.min(Hpx, line * step + letter + step * 0.15);
        ctx.save(); ctx.beginPath(); ctx.rect(0, y0, Wpx, y1 - y0); ctx.clip();
        ctx.drawImage(tint, 0, 0, Wpx, Hpx); ctx.restore();
        ctx.strokeStyle = S.color; ctx.lineWidth = lw; ctx.setLineDash([lw * 4, lw * 3]);
        ctx.strokeRect(lw, y0, Wpx - 2 * lw, y1 - y0); ctx.setLineDash([]);
      }
      return;
    }

    // grid template
    ctx.strokeStyle = S.color; ctx.fillStyle = S.color;
    // column edges
    ctx.globalAlpha = focus ? 0.5 : 0.9; ctx.lineWidth = lw * 1.5;
    ctx.beginPath(); ctx.moveTo(lw, 0); ctx.lineTo(lw, Hpx); ctx.moveTo(Wpx - lw, 0); ctx.lineTo(Wpx - lw, Hpx); ctx.stroke();
    for (let i = 0; i < S.rows; i++) {
      const y = i * step;
      const active = !focus || i === line;
      ctx.globalAlpha = active ? (focus ? 0.3 : 0.16) : 0.04;
      ctx.fillRect(0, y, Wpx, letter);
      ctx.globalAlpha = active ? 0.95 : dim;
      ctx.lineWidth = active && focus ? lw * 2 : lw;
      ctx.beginPath(); ctx.moveTo(0, y + ctx.lineWidth / 2); ctx.lineTo(Wpx, y + ctx.lineWidth / 2); ctx.stroke();
    }
    // bottom boundary of the block
    ctx.globalAlpha = focus ? 0.4 : 0.7; ctx.lineWidth = lw; ctx.setLineDash([lw * 4, lw * 4]);
    ctx.beginPath(); ctx.moveTo(0, Hpx - lw / 2); ctx.lineTo(Wpx, Hpx - lw / 2); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  const tintCache = { src: null, color: null, out: null };
  function tintCanvas(mask, color) {
    if (tintCache.src === mask && tintCache.color === color) return tintCache.out;
    const c = document.createElement('canvas'); c.width = mask.width; c.height = mask.height;
    const x = c.getContext('2d');
    x.drawImage(mask, 0, 0); x.globalCompositeOperation = 'source-in';
    x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    Object.assign(tintCache, { src: mask, color, out: c });
    return c;
  }

  // ---------- mezuzah text (STaM font) ----------
  // Layout rules:
  //  * every letter is drawn exactly as the font designs it (same size, stroke widths, angles);
  //  * letters hang from the sirtut line; the space between words is exactly one yod;
  //  * every line reaches the left edge and nothing passes it. A line is filled only by dilating
  //    ה ת ם (and א ל when their shape allows it) the way a scribe does: the horizontal stroke is
  //    lengthened while legs, neck and tagin keep their shape. Letters nearest the end of the line first,
  //    equal shares, at most +1 letter width each; never inside a holy name;
  //  * setumah (common custom): line 6 ends ~3 letters short, line 7 opens with a 9-letter space;
  //  * line 22 holds only "על הארץ", at its start.
  const DILATABLE = ['א', 'ה', 'ל', 'ת', 'ם'];
  const MAX_EXTRA = 1.0;
  // names that are not erased: their letters are never dilated (אלהים in 11:16 "אלהים אחרים" is not holy)
  const HOLY = new Set(['יהוה', 'אלהינו', 'אלהיך', 'אלהיכם']);
  const sliceCache = new Map();
  // find a vertical slice of the glyph that crosses only horizontal strokes (same ink runs over a span)
  function glyphSlice(ch, px) {
    const key = ch + '|' + fontFamily() + '|' + Math.round(px);
    if (sliceCache.has(key)) return sliceCache.get(key);
    const m = document.createElement('canvas').getContext('2d'); m.font = `${px}px "${fontFamily()}"`;
    const adv = m.measureText(ch).width, pad = Math.ceil(px * 0.4);
    const G = document.createElement('canvas'); G.width = Math.ceil(adv + 2 * pad); G.height = Math.ceil(px * 1.8);
    const g = G.getContext('2d', { willReadFrequently: true });
    g.font = m.font; g.direction = 'rtl'; g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.fillStyle = '#fff';
    const O = G.width - pad, base = Math.round(px * 1.25);
    g.fillText(ch, O, base);
    const d = g.getImageData(0, 0, G.width, G.height).data;
    const runs = (x) => { const r = []; let st = -1; for (let y = 0; y < G.height; y++) { const on = d[(y * G.width + x) * 4 + 3] > 110; if (on && st < 0) st = y; if (!on && st >= 0) { r.push([st, y]); st = -1; } } if (st >= 0) r.push([st, G.height]); return r; };
    const tol = Math.max(1, px * 0.025), same = (a, b) => a.length === b.length && a.every((r, i) => Math.abs(r[0] - b[i][0]) <= tol && Math.abs(r[1] - b[i][1]) <= tol);
    const x0 = Math.round(O - adv * 0.85), x1 = Math.round(O - adv * 0.15); // stay away from the legs at both sides
    let best = null, cur = null;
    for (let x = x0; x <= x1; x++) {
      const r = runs(x);
      const ok = r.length >= 1 && r.length <= 2 && r.every(([a, b]) => b - a < px * 0.3);
      if (ok && cur && same(cur.sig, r)) { cur.end = x; }
      else { cur = ok ? { start: x, end: x, sig: r } : null; }
      if (cur && (!best || cur.end - cur.start > best.end - best.start)) best = { ...cur };
    }
    const res = best && best.end - best.start >= adv * 0.12 ? { G, O, cx: Math.round((best.start + best.end) / 2), base } : null;
    sliceCache.set(key, res);
    return res;
  }

  function layoutText(x, Wpx, planDilation = true) {
    const px = parseFloat(x.font);
    const yod = x.measureText('י').width;
    const avg = x.measureText('אבגדהוזחטיכלמנסעפצקרשת').width / 22;
    const BIG = 1.5;
    const SETUMAH = 6, LAST = TEXT.lines.length - 1;
    const isBig = (i, k) => S.bigLetters && i === 0 && (k === 0 || k === 5);
    const cw = {}; const W = (ch) => (cw[ch] ??= x.measureText(ch).width);
    const lines = TEXT.lines.map((ws, i) => ws.map((w, k) => [...w].map((ch, ci, arr) => {
      const big = isBig(i, k) && ci === arr.length - 1;
      return { ch, w: W(ch) * (big ? BIG : 1), big, e: 0 };
    })));
    const natural = lines.map((ws, i) => ws.reduce((a, cs) => a + cs.reduce((b, c) => b + c.w, 0), 0) + (ws.length - 1) * yod + (i === SETUMAH ? 9 * avg : 0));
    const report = [];
    if (planDilation) lines.forEach((ws, i) => {
      if (i === LAST) { report.push(0); return; }
      const target = i === SETUMAH - 1 ? Wpx - 3 * avg : Wpx;
      let R = target - natural[i];
      const cand = [];
      for (let k = ws.length - 1; k >= 0; k--) for (let ci = ws[k].length - 1; ci >= 0; ci--) {
        if (HOLY.has(TEXT.lines[i][k])) continue;
        const c = ws[k][ci];
        if (!c.big && DILATABLE.includes(c.ch) && glyphSlice(c.ch, px)) cand.push(c);
      }
      if (R > 0.5 && cand.length) {
        let done = false;
        // prefer many small dilations; allow longer ones only when the line cannot be filled otherwise
        for (const cap of [MAX_EXTRA, 1.6, 2.2]) {
          for (let n = 1; n <= cand.length && !done; n++) {
            const share = R / n;
            if (cand.slice(0, n).every((c) => c.w * cap >= share)) { cand.slice(0, n).forEach((c) => { c.e = share; }); done = true; }
          }
          if (done) { R = 0; break; }
        }
        if (!done) cand.forEach((c) => { c.e = c.w * 2.2; R -= c.e; });
      }
      report.push(Math.max(0, R));
    });
    return { lines, yod, avg, SETUMAH, LAST, report, natural };
  }

  function drawDilated(x, ch, xr, base, extra, px) {
    const sl = glyphSlice(ch, px);
    const { G, O, cx } = sl;
    const top = base - sl.base; // align baselines
    const rightW = G.width - cx, leftW = cx;
    x.drawImage(G, cx, 0, rightW, G.height, xr - (O - cx), top, rightW, G.height);              // right part (as is)
    x.drawImage(G, cx - 1, 0, 1, G.height, xr - (O - cx) - extra, top, extra + 0.5, G.height);  // lengthened stroke
    x.drawImage(G, 0, 0, leftW, G.height, xr - (O - cx) - extra - leftW, top, leftW, G.height); // left part (as is)
  }

  function textMask(Wpx, Hpx) {
    const key = [Wpx, Hpx, rowGeom(Hpx).letter.toFixed(3), S.bigLetters, fontFamily()].join('|');
    if (maskCache.key === key) return maskCache.c;
    const c = document.createElement('canvas'); c.width = Wpx; c.height = Hpx;
    const x = c.getContext('2d');
    const { step, letter } = rowGeom(Hpx);
    x.font = `100px "${fontFamily()}"`;
    const mh = x.measureText('ה');
    const body = (mh.actualBoundingBoxAscent + mh.actualBoundingBoxDescent) || 70;
    const px = 100 * letter / body;
    x.font = `${px}px "${fontFamily()}"`; x.direction = 'rtl'; x.textAlign = 'right'; x.textBaseline = 'alphabetic'; x.fillStyle = '#fff';
    const asc = x.measureText('ה').actualBoundingBoxAscent;
    const L = layoutText(x, Wpx);
    L.lines.forEach((ws, i) => {
      let xr = Wpx - (i === L.SETUMAH ? 9 * L.avg : 0);
      const base = i * step + asc;
      ws.forEach((cs, k) => {
        for (const ch of cs) {
          if (ch.e > 0.5) drawDilated(x, ch.ch, xr, base, ch.e, px);
          else if (ch.big) { x.save(); x.translate(xr, base - asc); x.scale(1.5, 1.5); x.translate(0, asc); x.fillText(ch.ch, 0, 0); x.restore(); }
          else x.fillText(ch.ch, xr, base);
          xr -= ch.w + ch.e;
        }
        if (k < ws.length - 1) xr -= L.yod;
      });
    });
    Object.assign(maskCache, { key, c, gaps: L.report });
    return c;
  }
  const maskCache = { key: '', c: null };

  // r = letter body height / longest line width, at the font's own proportions
  function computeRatio() {
    const m = document.createElement('canvas').getContext('2d');
    m.font = `100px "${fontFamily()}"`;
    const mh = m.measureText('ה');
    const body = (mh.actualBoundingBoxAscent + mh.actualBoundingBoxDescent) || 70;
    const L = layoutText(m, 1e9, false);
    textState.r = body / Math.max(...L.natural.filter((_, i) => i !== L.LAST));
    maskCache.key = '';
  }
  function fontFamily() { return textState.userFont ? textState.userFont.family : FONT_FAMILY; }

  async function loadUserFont(file) {
    if (!file) return;
    if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('סוג קובץ לא נתמך. אפשר TTF, OTF, WOFF או WOFF2.');
    if (file.size > 20 * 1024 * 1024) throw new Error('הקובץ גדול מדי.');
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    const family = 'UserStam' + Date.now();
    const ff = new FontFace(family, buf);
    await ff.load(); document.fonts.add(ff);
    const m = document.createElement('canvas').getContext('2d'); m.font = `100px "${family}"`;
    if (!(m.measureText('ה').actualBoundingBoxAscent > 1)) throw new Error('בגופן הזה אין אותיות עבריות.');
    textState.userFont = { family, name: file.name, hash };
    sliceCache.clear(); computeRatio();
  }

  async function initText() {
    try {
      const flat = TEXT.lines.map((l) => l.join(' ')).join('\n');
      const letters = TEXT.lines.flat().join('').length;
      if (TEXT.lines.length !== 22 || letters !== 713 || /[^\u05d0-\u05ea \n]/.test(flat)) throw new Error('בדיקת שלמות הטקסט נכשלה');
      const h = await sha256Hex(new TextEncoder().encode(flat));
      if (h && h !== TEXT_SHA256) throw new Error('טביעת הטקסט לא תואמת');
      textState.hash = h || '';
      const ff = new FontFace(FONT_FAMILY, `url(${stamFontUrl})`);
      await ff.load(); document.fonts.add(ff);
      computeRatio();
      textState.ready = true;
    } catch (e) {
      textState.error = (e && e.message) || 'טעינת הטקסט נכשלה';
    }
    renderTextProof(); syncUI();
  }

  function renderTextProof() {
    const box = $('textProof'); if (!box) return;
    const ol = $('proofLines'); ol.textContent = '';
    TEXT.lines.forEach((l) => { const li = document.createElement('li'); li.textContent = l.join(' '); ol.appendChild(li); });
    $('proofMeta').textContent = textState.error
      ? textState.error
      : `${TEXT.lines.length} שורות · ${TEXT.lines.flat().join('').length} אותיות · בדיקת שלמות עברה. טביעת הטקסט:`;
    $('proofMeta').classList.toggle('err', !!textState.error);
    $('proofHash').textContent = textState.hash ? 'SHA-256: ' + textState.hash : '';
    $('proofHash').hidden = !textState.hash;
  }

  // ---------- image loading ----------
  async function sha256Hex(buf) {
    if (!(window.crypto && crypto.subtle)) return null;
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function loadImageFile(file) {
    ui.imgErr.hidden = true;
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('סוג הקובץ לא נתמך. אפשר לבחור PNG, JPG או WEBP.');
    if (file.size > 40 * 1024 * 1024) throw new Error('הקובץ גדול מדי (יותר מ-40MB).');
    ui.imgFileLbl.textContent = 'טוען…';
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    const bmp = await createImageBitmap(new Blob([buf], { type: file.type }), { imageOrientation: 'from-image' });
    const scale = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    const W = Math.max(1, Math.round(bmp.width * scale)), H = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(bmp, 0, 0, W, H);
    bmp.close && bmp.close();
    const id = x.getImageData(0, 0, W, H); const d = id.data;
    const LO = 0.35, HI = 0.72;
    const rowN = new Uint32Array(H), colN = new Uint32Array(W);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      const a = Math.min(1, Math.max(0, (HI - lum) / (HI - LO)));
      d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
      if (a > 0.5) { rowN[(p / W) | 0]++; colN[p % W]++; }
    }
    // ignore isolated specks: a row/column counts only if it holds a minimal amount of ink
    const rMin = Math.max(2, Math.round(W * 0.002)), cMin = Math.max(2, Math.round(H * 0.002));
    let minY = rowN.findIndex((n) => n >= rMin), minX = colN.findIndex((n) => n >= cMin);
    let maxY = H - 1 - [...rowN].reverse().findIndex((n) => n >= rMin);
    let maxX = W - 1 - [...colN].reverse().findIndex((n) => n >= cMin);
    if (minY < 0 || minX < 0) maxX = -1;
    if (maxX < 0) throw new Error('לא נמצא כתב בתמונה. נסו סריקה עם ניגודיות גבוהה יותר.');
    x.putImageData(id, 0, 0);
    let mask = c;
    if (S.autoTrim) {
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      if (cw < 20 || ch < 20) throw new Error('שטח הכתב שנמצא קטן מדי.');
      mask = document.createElement('canvas'); mask.width = cw; mask.height = ch;
      mask.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
    }
    S.img = { mask, aspect: mask.height / mask.width, hash, name: file.name };
    ui.imgFileLbl.textContent = file.name;
    ui.imgHash.hidden = false;
    ui.imgHash.textContent = hash ? 'SHA-256: ' + hash : 'SHA-256 לא זמין בהקשר הזה (נדרש https)';
  }

  // ---------- 2D UI ----------
  const marginEls = () => ['mt', 'mb', 'mr', 'ml'].map((id) => $(id));
  function syncUI() {
    invalid.clear(); for (const el of [ui.w, ui.h, ui.rows, ui.letterPct, ...marginEls()]) { el.style.borderColor = ''; el.setAttribute('aria-invalid', 'false'); }
    ui.w.value = S.w; ui.h.value = S.h; ui.rows.value = S.rows; ui.letterPct.value = S.letterPct;
    marginEls().forEach((el) => { el.value = S[el.id]; });
    ui.opacity.value = Math.round(S.opacity * 100); ui.opVal.textContent = Math.round(S.opacity * 100) + '%';
    ui.autoTrim.checked = S.autoTrim; $('bigLetters').checked = S.bigLetters;
    document.querySelector(`input[name=tpl][value=${S.tpl}]`).checked = true;
    document.querySelector(`input[name=cal][value=${S.cal}]`).checked = true;
    const col = document.querySelector(`input[name=color][value="${S.color}"]`); if (col) col.checked = true;
    ui.imgBox.hidden = S.tpl !== 'image';
    $('textBox').hidden = S.tpl !== 'text';
    $('marginBox').hidden = !onKlaf();
    $('sizeLegend').textContent = onKlaf() ? 'גודל הקלף (ס"מ)' : 'גודל שטח הכתב (ס"מ)';
    ui.rows.disabled = S.tpl === 'text';
    if (S.tpl === 'text') ui.rows.value = TEXT.lines.length;
    refreshDerived();
  }

  // values that follow from the inputs; never overwrites the field being typed in
  function refreshDerived(typing) {
    const imgMode = S.tpl === 'image' && S.img, txt = S.tpl === 'text';
    ui.h.disabled = !!imgMode;
    if (imgMode && typing !== ui.h) ui.h.value = outerH();
    document.querySelectorAll('input[name=preset]').forEach((r) => { r.checked = +r.value === S.w; });
    ui.letterPct.disabled = txt;
    const ts = txt ? textSize() : null;
    if (txt && ts.mm) ui.letterPct.value = Math.round(ts.p * 100);
    const bw = blockW(), bh = heightCm();
    const tooSmall = bw < 2 || bh < 2;
    if (tooSmall) invalid.add('block'); else invalid.delete('block');
    const parts = [];
    if (onKlaf()) parts.push(`שטח הכתב: ${bw} × ${bh} ס"מ.`);
    if (imgMode) parts.push('הגובה מחושב לפי היחס בתמונה. קובעים רק את הרוחב.');
    if (tooSmall) parts.push('השוליים גדולים מדי לקלף הזה.');
    if (!onKlaf() && !imgMode) parts.push('המידות של שטח הכתב בלבד, בלי השוליים.');
    ui.sizeHint.textContent = parts.join(' ');
    ui.sizeHint.classList.toggle('err', tooSmall);
    const lh = $('letterHint');
    if (txt && ts.mm) {
      lh.hidden = false;
      const bad = ts.raw > 0.85 || ts.raw < 0.45;
      lh.textContent = `גובה אות: ${ts.mm.toFixed(2)} מ"מ (${Math.round(ts.p * 100)}% מהשורה). גודל האות נקבע לפי הרוחב: האותיות שומרות על הצורה והעובי של הגופן, והשורה הארוכה מגיעה לקצה כשבין המילים רווח של י'.`
        + (ts.raw > 0.85 ? ' הגובה קצר מדי לרוחב, ולכן האותיות הוקטנו והשורות מתמלאות בהמשכה.' : '')
        + (ts.raw < 0.45 ? ' יש רווח גדול בין השורות. אפשר להקטין את הגובה.' : '');
      lh.classList.toggle('err', bad);
    } else lh.hidden = true;
    ui.dimW.textContent = bw; ui.dimH.textContent = bh; ui.dimRows.textContent = rowCount();
    updateEnter();
    renderPreview();
  }

  function renderPreview() {
    $('dimSqueeze').textContent = '';
    const noImg = S.tpl === 'image' && !S.img;
    const noText = S.tpl === 'text' && !textState.ready;
    ui.stageEmpty.hidden = !(noImg || noText); ui.canvas.hidden = noImg || noText;
    ui.stageEmpty.textContent = noImg ? 'בחרו קובץ תמונה כדי לראות את התבנית'
      : textState.error ? 'הטקסט לא נטען: ' + textState.error : 'טוען גופן…';
    if (noImg || noText || invalid.has('block')) return;
    const OW = outerW(), OH = outerH(), BW = blockW(), BH = heightCm();
    const ppc = (S.tpl === 'text' ? 1400 : 900) / OW; // px per cm
    ui.canvas.width = Math.round(OW * ppc); ui.canvas.height = Math.round(OH * ppc);
    const pctx = ui.canvas.getContext('2d');
    const ox = onKlaf() ? Math.round((OW - BW - S.mr / 10) * ppc) : 0, oy = onKlaf() ? Math.round(S.mt / 10 * ppc) : 0;
    const Wpx = Math.round(BW * ppc), Hpx = Math.round(BH * ppc);
    if (onKlaf()) { // the klaf itself, with its margins
      pctx.fillStyle = 'rgba(160,120,60,0.10)'; pctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height);
      pctx.strokeStyle = '#8a6a3a'; pctx.lineWidth = 3; pctx.strokeRect(1.5, 1.5, ui.canvas.width - 3, ui.canvas.height - 3);
    }
    const tmp = document.createElement('canvas'); tmp.width = Wpx; tmp.height = Hpx;
    drawTemplate(tmp.getContext('2d'), Wpx, Hpx, { mode: 'full' });
    pctx.drawImage(tmp, ox, oy);
    if (S.tpl === 'image' || onKlaf()) { pctx.strokeStyle = '#1d4ed8'; pctx.lineWidth = 2; pctx.setLineDash([8, 6]); pctx.strokeRect(ox + 1, oy + 1, Wpx - 2, Hpx - 2); pctx.setLineDash([]); }
    const sq = $('dimSqueeze');
    if (S.tpl === 'text') {
      const short = (maskCache.gaps || []).filter((g) => g > Wpx * 0.004).length;
      sq.textContent = short ? ` · ${short} שורות לא מגיעות לקצה` : '';
    }
  }

  const invalid = new Set();
  function readNum(el, lo, hi, fallback) {
    const v = parseFloat(el.value);
    const ok = Number.isFinite(v) && v >= lo && v <= hi;
    if (ok) invalid.delete(el.id); else invalid.add(el.id);
    el.setAttribute('aria-invalid', ok ? 'false' : 'true');
    el.style.borderColor = ok ? '' : 'var(--danger)';
    return ok ? v : fallback;
  }

  ui.form.addEventListener('submit', (e) => e.preventDefault());
  ui.form.addEventListener('input', async (e) => {
    const t = e.target;
    if (t.name === 'tpl') { S.tpl = t.value; }
    else if (t.name === 'cal') { S.cal = t.value; }
    else if (t.name === 'preset') { S.w = +t.value; if (S.tpl !== 'image') S.h = +t.value; }
    else if (t.name === 'color') { S.color = t.value; }
    else if (t === ui.w) { S.w = readNum(ui.w, 3, 60, S.w); }
    else if (t === ui.h) { S.h = readNum(ui.h, 3, 60, S.h); }
    else if (t === ui.rows) { S.rows = Math.round(readNum(ui.rows, 1, 60, S.rows)); }
    else if (t === ui.letterPct) { S.letterPct = readNum(ui.letterPct, 20, 90, S.letterPct); }
    else if (['mt', 'mb', 'mr', 'ml'].includes(t.id)) { S[t.id] = readNum(t, 0, 30, S[t.id]); }
    else if (t === ui.opacity) { S.opacity = +ui.opacity.value / 100; }
    else if (t === ui.autoTrim) { S.autoTrim = ui.autoTrim.checked; }
    else if (t.id === 'bigLetters') { S.bigLetters = t.checked; }
    else return;
    save();
    if (t.type === 'number') { refreshDerived(t); return; } // keep what is being typed
    if (t.name === 'preset') ui.h.value = S.h;
    if (t.name === 'preset') ui.w.value = S.w;
    syncUI();
  });

  $('fontFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    $('fontErr').hidden = true;
    try {
      $('fontFileLbl').textContent = 'טוען…';
      await loadUserFont(f);
      $('fontFileLbl').textContent = f.name;
      $('fontHash').hidden = false; $('fontHash').textContent = 'SHA-256: ' + (textState.userFont.hash || 'לא זמין');
    } catch (err) {
      $('fontFileLbl').textContent = 'גופן משלך: TTF / OTF / WOFF (לא חובה)';
      $('fontErr').textContent = (err && err.message) || 'טעינת הגופן נכשלה.'; $('fontErr').hidden = false;
    }
    syncUI();
  });

  ui.imgFile.addEventListener('change', async () => {
    const f = ui.imgFile.files && ui.imgFile.files[0];
    try { await loadImageFile(f); }
    catch (err) {
      S.img = null; ui.imgHash.hidden = true;
      ui.imgFileLbl.textContent = 'בחירת קובץ תמונה (PNG / JPG)';
      ui.imgErr.textContent = err.message || 'טעינת התמונה נכשלה.'; ui.imgErr.hidden = false;
    }
    syncUI();
  });

  let xrSupported = false;
  function setStatus(s, text) { ui.status.dataset.s = s; ui.statusText.textContent = text; }
  function updateEnter() {
    const needImg = (S.tpl === 'image' && !S.img) || (S.tpl === 'text' && !textState.ready);
    const bad = invalid.size > 0;
    ui.enter.disabled = !xrSupported || needImg || bad;
    ui.enterHint.textContent = !window.isSecureContext ? 'צריך לפתוח את הדף בכתובת https.'
      : !xrSupported ? 'הכניסה ל-AR זמינה רק בדפדפן של הקסדה (Meta Quest Browser).'
      : needImg ? (S.tpl === 'text' ? 'הטקסט עדיין נטען, או שבדיקת השלמות נכשלה.' : 'צריך לבחור קודם קובץ תמונה של התיקון.')
      : bad ? 'יש ערך לא תקין באחד השדות (מסומן באדום).' : 'ודאו שהקלף מקובע ושיש אור טוב.';
  }

  async function checkSupport() {
    if (!window.isSecureContext) { setStatus('err', 'צריך לפתוח בכתובת https'); return; }
    if (!navigator.xr) { setStatus('warn', 'אין WebXR בדפדפן הזה. רק תצוגה מקדימה'); return; }
    try {
      xrSupported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (_) { xrSupported = false; }
    if (xrSupported) setStatus('ok', 'מוכן ל-AR');
    else setStatus('warn', 'אין תמיכה ב-AR במכשיר הזה. רק תצוגה מקדימה');
    updateEnter();
  }

  // ---------- XR scene ----------
  let renderer, scene, camera, session = null, refSpace = null;
  let outline = null;
  let root, adjust, mesh, tex, texCanvas, labels, labelTex, labelCanvas, panel, panelTex, panelCanvas;
  const cursors = new Map(); // inputSource -> mesh
  const calib = { step: 0, pts: [], markers: [], msg: '' };
  const lock = { locked: false, confirm: false, baseMatrix: new THREE.Matrix4(), anchor: null, wantAnchor: false, measured: null };
  const pinching = new Set(); let pinchHoldStart = 0;
  // canvas bidi ignores directional marks, so signs are expressed in words
  const sgn = (v, pos, neg, d = 1) => { const a = Math.abs(v).toFixed(d); return +a === 0 ? (0).toFixed(d) : `${a} ${v > 0 ? pos : neg}`; };
  function sizeGap() {
    if (!lock.measured) return null;
    const dw = (lock.measured.mw - outerW()) * 10, dh = (lock.measured.mh - outerH()) * 10; // mm
    const tolW = Math.max(2.5, outerW() * 10 * 0.02), tolH = Math.max(2.5, outerH() * 10 * 0.02);
    return { dw, dh, warn: Math.abs(dw) > tolW || Math.abs(dh) > tolH };
  }
  const adj = { dx: 0, dy: 0, dz: 0, rot: 0 };
  const pad = new Map(); // inputSource -> {buttons:[], stick:{t, next}}
  let trackingLost = false, gripHoldStart = 0, panelDirty = true;

  function makeCanvasPlane(w, h, cw, ch) {
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    return { c, t, m };
  }

  function initThree() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.domElement.style.display = 'none';
    document.body.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, 1, 0.01, 20);

    root = new THREE.Group(); root.matrixAutoUpdate = false; root.visible = false; scene.add(root);
    adjust = new THREE.Group(); root.add(adjust);

    const p = makeCanvasPlane(0.16, 0.05, 1024, 320);
    panelCanvas = p.c; panelTex = p.t; panel = p.m; panel.renderOrder = 10;
    panel.material.depthTest = false;
    scene.add(panel);
  }

  function buildBlock() {
    const W = blockW() / 100, H = heightCm() / 100, off = blockOffset();
    if (outline) { adjust.remove(outline); outline.geometry.dispose(); outline.material.dispose(); outline = null; }
    if (onKlaf()) {
      const OW = outerW() / 100, OH = outerH() / 100;
      const g = new THREE.BufferGeometry().setFromPoints([[0, 0], [-OW, 0], [-OW, -OH], [0, -OH]].map(([a, b]) => new THREE.Vector3(a, b, 0)));
      outline = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: new THREE.Color(S.color), transparent: true, opacity: 0.45, depthWrite: false }));
      outline.renderOrder = 1; adjust.add(outline);
    }
    if (mesh) { adjust.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); tex.dispose(); }
    if (labels) { adjust.remove(labels); labels.geometry.dispose(); labels.material.dispose(); labelTex.dispose(); }
    const cw = Math.round(Math.min(TEX_MAX, TEX_MAX * W / H)), ch = Math.round(cw * H / W);
    const b = makeCanvasPlane(W, H, cw, ch);
    texCanvas = b.c; tex = b.t; mesh = b.m; mesh.material.opacity = S.opacity; mesh.renderOrder = 2;
    mesh.position.set(off.x - W / 2, off.y - H / 2, 0); // block top-right corner = calibrated corner + margins
    adjust.add(mesh);
    const lb = makeCanvasPlane(0.012, H, 96, Math.min(4096, Math.round(96 * H / 0.012)));
    labelCanvas = lb.c; labelTex = lb.t; labels = lb.m; labels.renderOrder = 2;
    labels.position.set(off.x + 0.008, off.y - H / 2, 0);
    adjust.add(labels);
    redrawBlock();
  }

  function redrawBlock() {
    if (!texCanvas) return;
    drawTemplate(texCanvas.getContext('2d'), texCanvas.width, texCanvas.height, { mode: S.mode, line: S.line });
    tex.needsUpdate = true;
    mesh.material.opacity = S.opacity;
    if (outline) outline.material.color.set(S.color);
    // row numbers
    const x = labelCanvas.getContext('2d'); const Hp = labelCanvas.height, Wp = labelCanvas.width;
    x.clearRect(0, 0, Wp, Hp);
    if (S.mode !== 'off') {
      const { step, letter } = rowGeom(Hp);
      x.textAlign = 'center'; x.textBaseline = 'middle';
      for (let i = 0; i < rowCount(); i++) {
        const cur = i === S.line;
        x.globalAlpha = cur ? 1 : 0.55;
        x.fillStyle = S.color;
        x.font = `${cur ? 700 : 500} ${Math.min(56, step * 0.7)}px "Segoe UI",Arial,sans-serif`;
        x.fillText(String(i + 1), Wp / 2, i * step + letter / 2);
      }
      x.globalAlpha = 1;
    }
    labelTex.needsUpdate = true;
    labels.material.opacity = Math.min(1, S.opacity + 0.2);
    panelDirty = true;
  }

  function applyAdjust() {
    adjust.position.set(adj.dx, adj.dy, adj.dz + 0.0003);
    adjust.rotation.set(0, 0, adj.rot);
    panelDirty = true;
  }

  // ---------- panel ----------
  function drawPanel() {
    const c = panelCanvas, x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    x.fillStyle = 'rgba(18,18,22,0.86)';
    roundRect(x, 4, 4, W - 8, H - 8, 36); x.fill();
    x.direction = 'rtl'; x.textAlign = 'right'; x.textBaseline = 'top';
    const R = W - 48;
    const lines = [];
    if (trackingLost) {
      lines.push(['#ffb4a8', 700, 52, 'המעקב אבד']);
      lines.push(['#ffffff', 400, 38, 'הסתכלו סביב לאט, ודאו שיש מספיק אור.']);
    } else if (!lock.locked) {
      const names = ['ימנית-עליונה', 'שמאלית-עליונה', 'שמאלית-תחתונה'];
      lines.push(['#9ec1ff', 700, 50, `כיול · שלב ${calib.step + 1} מתוך 3`]);
      lines.push(['#ffffff', 600, 42, `כוונו את הנקודה לפינה ה${names[calib.step]}`]);
      lines.push(['#ffffff', 400, 36, (onKlaf() ? 'של הקלף' : 'של שטח הכתב') + ', ולחצו על ההדק (או צביטה ביד שמאל).']);
      if (calib.msg) lines.push(['#ffd27a', 600, 34, calib.msg]);
      else lines.push(['#c8c8c8', 400, 28, 'כלי עזר בלבד: שרטוט, כתיבה כסדרן והגהה – חובה.']);
    } else {
      const g = sizeGap();
      if (lock.confirm && g) {
        lines.push(['#ffd27a', 700, 46, 'פער בין המדידה לגודל שנבחר']);
        lines.push(['#ffffff', 400, 34, `נמדד: רוחב ${sgn(g.dw, 'מ"מ יותר', 'מ"מ פחות')} · גובה ${sgn(g.dh, 'מ"מ יותר', 'מ"מ פחות')}`]);
        lines.push(['#ffffff', 400, 32, 'ודאו שהגודל שנבחר נכון. הדק / צביטה = אישור.']);
        lines.push(['#c8c8c8', 400, 30, 'אחיזה כפולה ממושכת (או צביטה כפולה) = כיול מחדש']);
      } else {
        lines.push(['#9ec1ff', 700, 48, `שורה ${S.line + 1} מתוך ${rowCount()} · ${MODE_LABEL[S.mode]}`]);
        lines.push(['#ffffff', 400, 32, `מ"מ: ${sgn(adj.dx * 1000, 'ימינה', 'שמאלה')} · ${sgn(adj.dy * 1000, 'למעלה', 'למטה')} · ${sgn(adj.dz * 1000, 'מעל המשטח', 'לתוך המשטח')} · סיבוב ${sgn(THREE.MathUtils.radToDeg(adj.rot), 'נגד השעון', 'עם השעון')}`]);
        if (g) lines.push([g.warn ? '#ffd27a' : '#c8c8c8', 400, 30, `פער מדידה (מ"מ): רוחב ${sgn(g.dw, 'יותר', 'פחות')} · גובה ${sgn(g.dh, 'יותר', 'פחות')}`]);
        lines.push(['#c8c8c8', 400, 28, 'A/B שורה · X מצב · Y אטימות · לחיצה על ג\'ויסטיק ימני: איפוס הזזה']);
      }
    }
    let y = 40;
    for (const [col, wt, sz, txt] of lines) {
      x.fillStyle = col; x.font = `${wt} ${sz}px "Segoe UI","Noto Sans Hebrew",Arial,sans-serif`;
      x.fillText(txt, R, y, W - 96); y += sz * 1.45;
    }
    panelTex.needsUpdate = true; panelDirty = false;
  }
  const mm = (m) => { const t = (m * 1000).toFixed(1); return t === '-0.0' ? '0.0' : t; };
  function roundRect(x, a, b, w, h, r) {
    x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r);
    x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath();
  }

  // ---------- input ----------
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _dir = new THREE.Vector3();
  function tipOf(src, frame) {
    if (src.hand) {
      const j = src.hand.get('index-finger-tip');
      const p = j && frame.getJointPose ? frame.getJointPose(j, refSpace) : null;
      return p ? new THREE.Vector3(p.transform.position.x, p.transform.position.y, p.transform.position.z) : null;
    }
    const p = frame.getPose(src.targetRaySpace, refSpace);
    if (!p) return null;
    const o = p.transform.orientation, t = p.transform.position;
    _q.set(o.x, o.y, o.z, o.w); _dir.set(0, 0, -1).applyQuaternion(_q);
    return new THREE.Vector3(t.x, t.y, t.z).addScaledVector(_dir, TIP_OFFSET);
  }

  function cursorFor(src) {
    let c = cursors.get(src);
    if (!c) {
      c = new THREE.Group();
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0015, 16, 12), new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.004, 0.0048, 32), new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.8 }));
      dot.renderOrder = ring.renderOrder = 20;
      c.add(dot, ring); c.userData.ring = ring; scene.add(c); cursors.set(src, c);
    }
    return c;
  }

  let lastFrameTips = new Map();
  function onSelect(e) {
    const src = e.inputSource;
    if (trackingLost) return;
    if (lock.locked && lock.confirm) { lock.confirm = false; root.visible = !trackingLost; panelDirty = true; return; }
    if (!lock.locked) {
      // hands: point with the RIGHT index finger, confirm with a LEFT pinch
      let tip = null;
      if (src.hand) {
        if (src.handedness !== 'left') { calib.msg = 'צבטו עם היד השמאלית, והצביעו עם האצבע הימנית.'; panelDirty = true; return; }
        for (const [s, t] of lastFrameTips) if (s.hand && s.handedness === 'right' && t) tip = t;
        if (!tip) { calib.msg = 'היד הימנית לא מזוהה. הכניסו אותה לשדה הראייה.'; panelDirty = true; return; }
      } else tip = lastFrameTips.get(src) || null;
      if (!tip) { calib.msg = 'לא זוהתה נקודה. נסו שוב.'; panelDirty = true; return; }
      addCalibPoint(tip.clone());
    } else if (src.hand && src.handedness === 'left') {
      setLine(S.line + 1);
    }
  }

  function addCalibPoint(p) {
    calib.msg = '';
    if (calib.pts.length >= 1 && p.distanceTo(calib.pts[calib.pts.length - 1]) < 0.02) {
      calib.msg = 'הנקודה קרובה מדי לקודמת (פחות מ-2 ס"מ).'; panelDirty = true; return;
    }
    if (calib.pts.length === 2) {
      const a = calib.pts[0], b = calib.pts[1];
      const ab = b.clone().sub(a), ap = p.clone().sub(a);
      const area = ab.clone().cross(ap).length() / ab.length();
      if (area < 0.02) { calib.msg = 'הנקודה השלישית כמעט על אותו קו. כוונו לפינה התחתונה.'; panelDirty = true; return; }
    }
    calib.pts.push(p);
    const mk = new THREE.Mesh(new THREE.SphereGeometry(0.002, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
    mk.position.copy(p); mk.renderOrder = 15; scene.add(mk); calib.markers.push(mk);
    calib.step = calib.pts.length;
    if (calib.pts.length === 3) finishCalibration();
    panelDirty = true;
  }

  function finishCalibration() {
    const [p1, p2, p3] = calib.pts; // top-right, top-left, bottom-left
    const right = p1.clone().sub(p2).normalize();
    const upRaw = p2.clone().sub(p3);
    const normal = right.clone().cross(upRaw).normalize();
    // normal must face the viewer
    const camPos = new THREE.Vector3(); renderer.xr.getCamera().getWorldPosition(camPos);
    if (normal.dot(camPos.clone().sub(p1)) < 0) {
      // corners tapped in the wrong order (template would be mirrored / upside down)
      resetCalibration();
      calib.msg = 'סדר הפינות שגוי. מתחילים מחדש: ימין-עליון, שמאל-עליון, שמאל-תחתון.';
      panelDirty = true; return;
    }
    const up = normal.clone().cross(right).normalize();
    const m = new THREE.Matrix4().makeBasis(right, up, normal).setPosition(p1);
    lock.baseMatrix.copy(m);
    lock.measured = { mw: p1.distanceTo(p2) * 100, mh: Math.abs(p3.clone().sub(p2).dot(up)) * 100 };
    lock.locked = true; lock.wantAnchor = true; lock.anchor = null;
    lock.confirm = !!(sizeGap() && sizeGap().warn);
    root.matrix.copy(m); root.matrixWorldNeedsUpdate = true; root.visible = !trackingLost;
    for (const mk of calib.markers) mk.visible = false;
    S.line = 0; S.mode = 'full';
    if (S.tpl !== 'grid') S.opacity = Math.min(S.opacity, 0.5); // layout guide, not a stencil
    Object.assign(adj, { dx: 0, dy: 0, dz: 0, rot: 0 }); applyAdjust();
    buildBlock();
  }

  function resetCalibration() {
    for (const mk of calib.markers) { scene.remove(mk); mk.geometry.dispose(); mk.material.dispose(); }
    Object.assign(calib, { step: 0, pts: [], markers: [], msg: '' });
    if (lock.anchor && lock.anchor.delete) { try { lock.anchor.delete(); } catch (_) {} }
    Object.assign(lock, { locked: false, confirm: false, anchor: null, wantAnchor: false, measured: null });
    root.visible = false; panelDirty = true;
  }

  function setLine(n) { const r = rowCount(); S.line = (n + r) % r; redrawBlock(); }

  function pollGamepads(frame, now) {
    for (const src of session.inputSources) {
      const gp = src.gamepad; if (!gp || src.hand) continue;
      let st = pad.get(src); if (!st) { st = { prev: [], stick: { next: 0, active: false } }; pad.set(src, st); }
      const pressed = gp.buttons.map((b) => b && b.pressed);
      const edge = (i) => pressed[i] && !st.prev[i];
      if (lock.locked && !lock.confirm) {
        if (src.handedness === 'right') {
          if (edge(3)) { Object.assign(adj, { dx: 0, dy: 0, dz: 0, rot: 0 }); applyAdjust(); }
          if (edge(4)) setLine(S.line + 1);
          if (edge(5)) setLine(S.line - 1);
        } else if (src.handedness === 'left') {
          if (edge(4)) { S.mode = MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]; redrawBlock(); }
          if (edge(5)) {
            const i = OPACITY_STEPS.findIndex((o) => o > S.opacity + 1e-3);
            S.opacity = OPACITY_STEPS[i < 0 ? 0 : i]; redrawBlock();
          }
        }
        // thumbstick nudges with auto-repeat
        const ax = gp.axes.length >= 4 ? gp.axes[2] : 0, ay = gp.axes.length >= 4 ? gp.axes[3] : 0;
        const mag = Math.max(Math.abs(ax), Math.abs(ay));
        if (mag > 0.6) {
          if (!st.stick.active || now >= st.stick.next) {
            st.stick.next = now + (st.stick.active ? 110 : 380); st.stick.active = true;
            const horiz = Math.abs(ax) >= Math.abs(ay);
            if (src.handedness === 'right') {
              if (horiz) adj.dx += Math.sign(ax) * NUDGE; else adj.dy += -Math.sign(ay) * NUDGE;
            } else {
              if (horiz) adj.rot -= Math.sign(ax) * ROT_STEP; else adj.dz = Math.max(-0.005, Math.min(0.005, adj.dz + Math.sign(ay) * NUDGE));
            }
            applyAdjust();
          }
        } else st.stick.active = false;
      }
      st.prev = pressed;
    }
    // both grips held ≥ 1s → recalibrate
    let grips = 0;
    for (const src of session.inputSources) if (src.gamepad && !src.hand && src.gamepad.buttons[1] && src.gamepad.buttons[1].pressed) grips++;
    if (grips >= 2 && lock.locked) {
      if (!gripHoldStart) gripHoldStart = now;
      else if (now - gripHoldStart > 1000) { gripHoldStart = 0; resetCalibration(); }
    } else gripHoldStart = 0;
    if (pinching.size >= 2 && lock.locked) {
      if (!pinchHoldStart) pinchHoldStart = now;
      else if (now - pinchHoldStart > 1500) { pinchHoldStart = 0; resetCalibration(); }
    } else pinchHoldStart = 0;
  }

  // ---------- frame loop ----------
  const _camPos = new THREE.Vector3(), _camQ = new THREE.Quaternion(), _fwd = new THREE.Vector3(), _target = new THREE.Vector3();
  function onFrame(time, frame) {
    if (!frame || !session) return;
    refSpace = renderer.xr.getReferenceSpace();
    const vp = frame.getViewerPose(refSpace);
    const lost = !vp || vp.emulatedPosition;
    if (lost !== trackingLost) { trackingLost = lost; panelDirty = true; }
    root.visible = lock.locked && !trackingLost;

    // anchors
    if (lock.locked && lock.wantAnchor && frame.createAnchor) {
      lock.wantAnchor = false;
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      lock.baseMatrix.decompose(pos, q, sc);
      frame.createAnchor(new XRRigidTransform({ x: pos.x, y: pos.y, z: pos.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), refSpace)
        .then((a) => { if (lock.locked) lock.anchor = a; else if (a.delete) a.delete(); })
        .catch(() => { /* anchors unavailable: keep base pose */ });
    }
    if (lock.locked && lock.anchor && frame.trackedAnchors && frame.trackedAnchors.has(lock.anchor)) {
      const ap = frame.getPose(lock.anchor.anchorSpace, refSpace);
      if (ap) { root.matrix.fromArray(ap.transform.matrix); root.matrixWorldNeedsUpdate = true; }
    }

    const xrCam = renderer.xr.getCamera();
    xrCam.getWorldPosition(_camPos); xrCam.getWorldQuaternion(_camQ);

    // cursors
    const seen = new Set(); lastFrameTips = new Map();
    for (const src of session.inputSources) {
      const tip = tipOf(src, frame); lastFrameTips.set(src, tip); seen.add(src);
      const c = cursorFor(src);
      c.visible = !!tip && !lock.locked;
      if (tip) { c.position.copy(tip); c.userData.ring.lookAt(_camPos); }
    }
    for (const [src, c] of cursors) if (!seen.has(src)) { c.visible = false; }

    pollGamepads(frame, time);

    // panel placement
    if (lock.locked && !trackingLost) {
      const W = outerW() / 100;
      _target.set(-W / 2, 0.035, 0.002).applyMatrix4(adjust.matrixWorld);
      panel.position.copy(_target);
      panel.quaternion.setFromRotationMatrix(adjust.matrixWorld);
      panel.scale.setScalar(Math.max(0.8, Math.min(1.4, W / 0.12)));
    } else {
      _fwd.set(0, -0.12, -0.45).applyQuaternion(_camQ).add(_camPos);
      panel.position.lerp(_fwd, 0.15);
      panel.quaternion.slerp(_camQ, 0.15);
      panel.scale.setScalar(1);
    }
    if (panelDirty) drawPanel();
    renderer.render(scene, camera);
  }

  // ---------- session ----------
  async function enterAR() {
    ui.arErr.hidden = true;
    ui.enter.classList.add('loading'); ui.enter.disabled = true; ui.enterLbl.textContent = 'פותח…';
    try {
      initThree();
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking', 'anchors'],
      });
      session.addEventListener('end', onEnd);
      session.addEventListener('select', onSelect);
      session.addEventListener('selectstart', (e) => { if (e.inputSource.hand) pinching.add(e.inputSource); });
      session.addEventListener('selectend', (e) => pinching.delete(e.inputSource));
      await renderer.xr.setSession(session);
      const rs = renderer.xr.getReferenceSpace();
      if (rs && rs.addEventListener) rs.addEventListener('reset', () => {
        if (!lock.locked) return;
        resetCalibration(); calib.msg = 'הקסדה אופסה (recenter). צריך לכייל מחדש.'; panelDirty = true;
      });
      S.mode = 'full'; S.line = 0;
      resetCalibration(); panelDirty = true;
      renderer.setAnimationLoop(onFrame);
    } catch (err) {
      session = null;
      ui.arErr.textContent = 'לא ניתן לפתוח מצב AR: ' + (err && err.message ? err.message : 'שגיאה לא ידועה') + '. ודאו שההרשאה אושרה ושהדף פתוח ב-https.';
      ui.arErr.hidden = false;
    } finally {
      ui.enter.classList.remove('loading'); ui.enterLbl.textContent = 'כניסה למצב AR'; updateEnter();
    }
  }

  function onEnd() {
    renderer.setAnimationLoop(null);
    for (const [, c] of cursors) scene.remove(c);
    cursors.clear(); pad.clear(); pinching.clear();
    resetCalibration();
    session = null;
  }

  ui.enter.addEventListener('click', () => { if (!session) enterAR(); });

  // test hook (read-only snapshot, used by automated tests)
  window.__mezuzah = {
    snapshot: (dist = 0.3) => {
      if (!lock.locked) return null;
      const r2 = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      r2.setSize(700, 700); r2.setClearColor(0xf4ecd8, 1);
      scene.updateMatrixWorld(true);
      const c = new THREE.Vector3(-outerW() / 200, -outerH() / 200, 0).applyMatrix4(adjust.matrixWorld);
      const n = new THREE.Vector3().setFromMatrixColumn(adjust.matrixWorld, 2).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(adjust.matrixWorld, 1).normalize();
      const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 5);
      cam.position.copy(c).addScaledVector(n, dist); cam.up.copy(up); cam.lookAt(c);
      r2.render(scene, cam); const url = r2.domElement.toDataURL('image/png'); r2.dispose(); return url;
    },
    text: () => ({ ...textState }),
    gaps: () => maskCache.gaps,
    slices: () => Object.fromEntries(DILATABLE.map((c) => [c, !!glyphSlice(c, 120)])),
    state: () => ({ confirm: lock.confirm, locked: lock.locked, step: calib.step, line: S.line, mode: S.mode, opacity: S.opacity, adj: { ...adj }, measured: lock.measured, msg: calib.msg, lost: trackingLost, inXR: !!session }),
  };

  // ---------- boot ----------
  load(); syncUI(); checkSupport(); initText();
}
