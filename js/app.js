/*
 * YatoVoid Music Box - editor.
 * Piano roll, playback, song library (browser storage), import/export,
 * selection, drag, copy/paste and undo/redo.
 */
"use strict";

(() => {
  const LO = 48, HI = 96, ROWS = HI - LO + 1, RH = 14, MAX_BARS = 64, KEYS_W = 52;
  const DRAFT_KEY = "yatovoid.musicbox.draft", LIBRARY_KEY = "yatovoid.musicbox.library";
  const $ = id => document.getElementById(id);

  const grid = $("grid"), ruler = $("ruler"), keys = $("keys");
  const g = grid.getContext("2d"), rg = ruler.getContext("2d"), kg = keys.getContext("2d");
  const gridWrap = $("gridWrap"), gridView = $("gridView"), rulerWrap = $("rulerWrap"), playheadHandle = $("playheadHandle");
  const scroller = $("scroller"), playhead = $("playhead"), boxEl = $("box"), chordRow = $("chordRow");

  let CW = 14;                 // pixels per 16th-note step
  let song = null;
  let selected = new Set();    // note objects
  let clipboard = [];
  let undoStack = [], redoStack = [];
  let hoverStep = 0;           // where Paste lands
  let cursorStep = 0;          // where playback starts
  let lastSavedJson = "";

  /* ---------- storage ---------- */
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } },
  };

  /* ---------- song helpers ---------- */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const volume = v => (v == null || isNaN(v) ? 1 : clamp(+v, 0, 1.5));
  const stepsPerBar = () => song.beatsPerBar * STEPS_PER_BEAT;
  const totalSteps = () => song.bars * stepsPerBar();
  const stepSeconds = () => 60 / song.bpm / STEPS_PER_BEAT;

  function cleanSong(s) {
    s = s || {};
    const out = {
      name: String(s.name || "Untitled").slice(0, 60),
      bpm: clamp(Math.round(+s.bpm) || 100, 40, 240),
      beatsPerBar: +s.beatsPerBar === 3 ? 3 : 4,
      bars: clamp(Math.round(+s.bars) || 8, 1, MAX_BARS),
      lead: VOICES[s.lead] ? s.lead : "musicbox",
      volumes: { lead: volume(s.volumes && s.volumes.lead), bass: volume(s.volumes && s.volumes.bass), chords: volume(s.volumes && s.volumes.chords) },
      chords: [],
      notes: [],
    };
    const chords = Array.isArray(s.chords) ? s.chords : [];
    for (let i = 0; i < out.bars; i++) out.chords.push(parseChord(chords[i]) ? chords[i] : "");
    for (const n of Array.isArray(s.notes) ? s.notes : []) {
      const m = Math.round(+n.m), st = Math.round(+n.s), d = Math.round(+n.d);
      if (m >= LO && m <= HI && st >= 0 && d >= 1) out.notes.push({ m, s: st, d });
    }
    return out;
  }

  const blankSong = () => cleanSong({ name: "Untitled", bpm: 110, beatsPerBar: 4, bars: 8, lead: "musicbox" });
  const serialize = () => JSON.stringify(song);

  /* ---------- undo ---------- */
  function pushUndo() {
    undoStack.push(serialize());
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
  }
  function restore(json) {
    song = JSON.parse(json);
    selected.clear();
    refreshAll();
  }
  function undo() {
    if (!undoStack.length) return toast("Nothing to undo");
    redoStack.push(serialize());
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return toast("Nothing to redo");
    undoStack.push(serialize());
    restore(redoStack.pop());
  }

  /* ---------- change handling ---------- */
  function changed() {
    store.set(DRAFT_KEY, song);
    updateTitle();
    drawGrid();
    scheduleRender();
  }
  function refreshAll() {
    syncControls();
    layout();
    changed();
  }
  function updateTitle() {
    const unsaved = serialize() !== lastSavedJson;
    $("saveState").textContent = unsaved ? "Not saved to library" : "Saved";
    $("saveState").dataset.state = unsaved ? "dirty" : "clean";
  }

  /* ---------- controls ---------- */
  function syncControls() {
    $("songName").value = song.name;
    $("bpm").value = song.bpm;
    $("timeSig").value = song.beatsPerBar;
    $("bars").value = song.bars;
    $("leadVoice").value = song.lead;
    $("volLead").value = song.volumes.lead;
    $("volBass").value = song.volumes.bass;
    $("volChords").value = song.volumes.chords;
  }

  function fillVoiceSelect() {
    $("leadVoice").innerHTML = Object.entries(VOICES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  }

  let nameBefore = null;
  $("songName").addEventListener("focus", () => { nameBefore = serialize(); });
  $("songName").addEventListener("input", e => { song.name = e.target.value.slice(0, 60) || "Untitled"; changed(); });
  $("songName").addEventListener("change", () => {
    if (nameBefore && nameBefore !== serialize()) { undoStack.push(nameBefore); redoStack = []; }
    nameBefore = serialize();
  });

  function bindNumber(id, apply) {
    $(id).addEventListener("change", e => {
      pushUndo();
      apply(e.target.value);
      refreshAll();
    });
  }
  bindNumber("bpm", v => { song.bpm = clamp(Math.round(+v) || song.bpm, 40, 240); });
  bindNumber("timeSig", v => { song.beatsPerBar = +v === 3 ? 3 : 4; });
  bindNumber("bars", v => {
    song.bars = clamp(Math.round(+v) || song.bars, 1, MAX_BARS);
    while (song.chords.length < song.bars) song.chords.push("");
    song.chords.length = song.bars;
  });
  bindNumber("leadVoice", v => { song.lead = v; });
  for (const [id, key] of [["volLead", "lead"], ["volBass", "bass"], ["volChords", "chords"]]) {
    $(id).addEventListener("pointerdown", () => pushUndo());
    $(id).addEventListener("input", e => { song.volumes[key] = +e.target.value; changed(); });
  }
  $("zoom").addEventListener("input", e => {
    const centre = (scroller.scrollLeft + scroller.clientWidth / 2) / CW;
    CW = +e.target.value;
    layout();
    drawGrid();
    scroller.scrollLeft = centre * CW - scroller.clientWidth / 2;
  });

  /* ---------- layout & drawing ----------
   * The note grid and bar ruler are drawn on canvases the size of the visible
   * area only. They stay pinned in view (CSS sticky) while a spacer element
   * provides the full scrollable size, and each redraw paints just the part of
   * the song that is scrolled into view. This keeps canvases small enough for
   * every graphics card and keeps drawing fast for long songs.
   */
  const HEADER_H = 56; // chord row + ruler
  const dpr = () => window.devicePixelRatio || 1;
  let ratio = 1, viewW = 1, viewH = 1;
  function sizeCanvas(c, w, h) {
    ratio = dpr();
    c.width = Math.max(1, Math.round(w * ratio));
    c.height = Math.max(1, Math.round(h * ratio));
    c.style.width = w + "px";
    c.style.height = h + "px";
    c.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  const W = () => totalSteps() * CW;
  const H = ROWS * RH;

  function resizeView() {
    viewW = Math.max(1, Math.min(W(), scroller.clientWidth - KEYS_W - 1));
    viewH = Math.max(1, Math.min(H, scroller.clientHeight - HEADER_H));
    gridView.style.width = viewW + "px";
    gridView.style.height = viewH + "px";
    sizeCanvas(grid, viewW, viewH);
    sizeCanvas(ruler, viewW, 22);
  }

  function layout() {
    gridWrap.style.width = W() + "px";
    gridWrap.style.height = H + "px";
    rulerWrap.style.width = W() + "px";
    sizeCanvas(keys, KEYS_W, H);
    playhead.style.height = H + "px";
    resizeView();
    buildChordRow();
    drawKeys();
    drawGrid();
    placePlayhead(source ? null : cursorStep);
  }

  let palette = {};
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["surface", "surface2", "line", "fg", "muted", "accent", "accent2", "noteText"]) {
      palette[k] = cs.getPropertyValue("--" + k).trim();
    }
  }
  const isBlackKey = m => [1, 3, 6, 8, 10].includes(m % 12);

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  // Coalesce redraws to at most one per animation frame.
  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawGrid(); });
  }

  /** Draws the visible part of the grid, its notes and the bar ruler. */
  function drawGrid() {
    if (!song) return;
    const ox = scroller.scrollLeft, oy = scroller.scrollTop;
    const spb = stepsPerBar(), total = totalSteps();
    g.setTransform(ratio, 0, 0, ratio, -ox * ratio, -oy * ratio);

    const r0 = Math.max(0, Math.floor(oy / RH)), r1 = Math.min(ROWS, Math.ceil((oy + viewH) / RH));
    for (let r = r0; r < r1; r++) {
      const m = HI - r;
      g.fillStyle = isBlackKey(m) ? palette.surface2 : palette.surface;
      g.fillRect(ox, r * RH, viewW, RH);
      if (m % 12 === 0) { g.fillStyle = palette.line; g.fillRect(ox, r * RH + RH - 1, viewW, 1); }
    }
    const s0 = Math.max(0, Math.floor(ox / CW)), s1 = Math.min(total, Math.ceil((ox + viewW) / CW));
    g.fillStyle = palette.line;
    for (let i = s0; i <= s1; i++) {
      const bar = i % spb === 0, beat = i % STEPS_PER_BEAT === 0;
      if (!bar && !beat && CW < 10) continue;
      g.globalAlpha = bar ? 1 : beat ? 0.55 : 0.22;
      g.fillRect(i * CW, oy, bar ? 2 : 1, viewH);
    }
    g.globalAlpha = 1;

    for (const n of song.notes) {
      const x = n.s * CW, y = (HI - n.m) * RH, w = n.d * CW;
      if (x > ox + viewW || x + w < ox || y > oy + viewH || y + RH < oy) continue;
      g.globalAlpha = n.s >= total ? 0.35 : 1;
      g.fillStyle = selected.has(n) ? palette.accent2 : palette.accent;
      roundRect(g, x + 1, y + 1, Math.max(3, w - 2), RH - 2, 3);
      g.fillStyle = palette.noteText;
      g.globalAlpha *= 0.45;
      g.fillRect(x + w - 4, y + 4, 1.5, RH - 8); // resize grip
      g.globalAlpha = 1;
    }
    drawRuler(ox);
  }

  function drawRuler(ox) {
    const spb = stepsPerBar(), total = totalSteps();
    rg.setTransform(ratio, 0, 0, ratio, -ox * ratio, 0);
    rg.fillStyle = palette.surface;
    rg.fillRect(ox, 0, viewW, 22);
    rg.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    rg.textBaseline = "middle";
    const first = Math.max(0, Math.floor(ox / CW / STEPS_PER_BEAT) * STEPS_PER_BEAT);
    for (let i = first; i <= total && i * CW <= ox + viewW; i += STEPS_PER_BEAT) {
      const bar = i % spb === 0;
      rg.fillStyle = bar ? palette.fg : palette.muted;
      rg.fillRect(i * CW, bar ? 0 : 14, 1, bar ? 22 : 8);
      if (bar && i < total) rg.fillText(String(i / spb + 1), i * CW + 5, 9);
    }
    rg.fillStyle = palette.line;
    rg.fillRect(ox, 21, viewW, 1);
  }

  function drawKeys() {
    kg.clearRect(0, 0, KEYS_W, H);
    kg.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    kg.textBaseline = "middle";
    for (let r = 0; r < ROWS; r++) {
      const m = HI - r;
      kg.fillStyle = isBlackKey(m) ? palette.surface2 : palette.surface;
      kg.fillRect(0, r * RH, KEYS_W, RH);
      kg.fillStyle = m % 12 === 0 ? palette.fg : palette.muted;
      kg.fillText(noteName(m), 8, r * RH + RH / 2 + 0.5);
      if (m % 12 === 0) { kg.fillStyle = palette.line; kg.fillRect(0, r * RH + RH - 1, KEYS_W, 1); }
    }
  }

  const CHORD_OPTIONS = ['<option value="">No chord</option>'].concat(
    CHORD_ROOTS.map(root => `<optgroup label="${root}">` +
      Object.keys(QUALITIES).map(q => `<option>${root + q}</option>`).join("") + "</optgroup>")
  ).join("");

  function buildChordRow() {
    chordRow.style.width = W() + "px";
    chordRow.innerHTML = "";
    const barW = stepsPerBar() * CW;
    for (let b = 0; b < song.bars; b++) {
      const sel = document.createElement("select");
      sel.id = "chord-" + b;
      sel.setAttribute("aria-label", "Chord for bar " + (b + 1));
      sel.innerHTML = CHORD_OPTIONS;
      sel.value = song.chords[b] || "";
      sel.style.width = barW - 6 + "px";
      sel.style.left = b * barW + 3 + "px";
      sel.addEventListener("change", () => { pushUndo(); song.chords[b] = sel.value; changed(); });
      chordRow.appendChild(sel);
    }
  }

  /* ---------- audio ---------- */
  let audioCtx = null, source = null, startedAt = 0, loopSeconds = 0, playingStepSec = 0, raf = 0, renderTimer = 0;
  let wantPlaying = false;

  // Audio is rendered in a background worker built from the synth code, so it works both online
  // and when index.html is opened as a local file. If workers are unavailable it renders here.
  const renderer = (() => {
    let worker = null, nextId = 1;
    const pending = new Map();
    const runHere = (song, resolve) => setTimeout(() => resolve(renderSong(song)), 0);
    try {
      const code = `"use strict";(${synthLib})(self);
        self.onmessage = e => { const mix = renderSong(e.data.song); self.postMessage({ id: e.data.id, mix }, [mix.buffer]); };`;
      worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      worker.onmessage = e => { const job = pending.get(e.data.id); pending.delete(e.data.id); if (job) job.resolve(e.data.mix); };
      worker.onerror = e => {
        e.preventDefault();
        worker = null;
        for (const job of pending.values()) runHere(job.song, job.resolve);
        pending.clear();
      };
    } catch (e) { worker = null; }
    return {
      get usesWorker() { return !!worker; },
      render(songCopy) {
        return new Promise(resolve => {
          if (!worker) return runHere(songCopy, resolve);
          const id = nextId++;
          pending.set(id, { song: songCopy, resolve });
          worker.postMessage({ id, song: songCopy });
        });
      },
    };
  })();

  // The rendered audio is cached against the song's contents, so pressing Play again is instant.
  let cached = { key: null, mix: null }, inflight = { key: null, promise: null };
  function getMix() {
    const key = serialize();
    if (cached.key === key) return Promise.resolve(cached.mix);
    if (inflight.key === key) return inflight.promise;
    const promise = renderer.render(JSON.parse(key)).then(mix => {
      cached = { key, mix };
      if (inflight.key === key) inflight = { key: null, promise: null };
      return mix;
    });
    inflight = { key, promise };
    return promise;
  }
  function scheduleRender() {
    clearTimeout(renderTimer);
    // Without a worker, rendering would block the page, so only do it when the song is playing.
    if (!source && !renderer.usesWorker) return;
    renderTimer = setTimeout(async () => {
      const key = serialize();
      const mix = await getMix();
      // Swap in the new audio at the same position if the song is still playing and unchanged since.
      if (source && key === serialize()) {
        const step = currentStep();
        startSource(mix, step);
      }
    }, source ? 150 : 400);
  }

  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function playBuffer(samples) {
    const a = ctx();
    const buf = a.createBuffer(1, samples.length, SR);
    buf.copyToChannel(samples, 0);
    const src = a.createBufferSource();
    src.buffer = buf;
    src.connect(a.destination);
    return src;
  }

  async function startPlayback(fromStep) {
    wantPlaying = true;
    ctx(); // create/resume audio inside the click so the browser allows sound
    const key = serialize();
    if (cached.key !== key) $("btnPlay").textContent = "Loading…";
    $("btnPlay").setAttribute("aria-pressed", "true");
    const mix = await getMix();
    if (!wantPlaying) return; // stopped while loading
    startSource(mix, fromStep);
  }
  function startSource(samples, fromStep) {
    const next = playBuffer(samples);
    next.loop = true;
    const nextLoop = samples.length / SR;
    const nextStepSec = stepSeconds();
    const offset = (fromStep * nextStepSec) % nextLoop;
    next.start(0, offset);
    stopSource(); // start the new buffer first, then drop the old one, to avoid a gap
    source = next;
    loopSeconds = nextLoop;
    playingStepSec = nextStepSec;
    startedAt = audioCtx.currentTime - offset;
    $("btnPlay").textContent = "Pause";
    document.body.classList.add("playing");
    cancelAnimationFrame(raf);
    tick();
  }
  function stopSource() {
    if (source) { try { source.stop(); } catch (e) { /* already stopped */ } source = null; }
  }
  function stopPlayback() {
    if (source) cursorStep = currentStep(); // pausing keeps the position
    wantPlaying = false;
    stopSource();
    cancelAnimationFrame(raf);
    $("btnPlay").textContent = "Play";
    $("btnPlay").setAttribute("aria-pressed", "false");
    document.body.classList.remove("playing");
    placePlayhead(cursorStep);
  }
  const currentStep = () => (((audioCtx.currentTime - startedAt) % loopSeconds) / playingStepSec);
  function tick() {
    raf = requestAnimationFrame(tick);
    if (scrubbing) return;
    const step = currentStep();
    placePlayhead(step);
    const x = step * CW;
    if ($("follow").checked && (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - KEYS_W - 40)) {
      scroller.scrollLeft = Math.max(0, x - 40);
    }
  }
  function placePlayhead(step) {
    if (step == null) return;
    const t = `translateX(${step * CW}px)`;
    playhead.style.transform = t;
    playheadHandle.style.transform = t;
  }
  function togglePlay() { wantPlaying ? stopPlayback() : startPlayback(cursorStep); }

  let lastPreview = 0;
  function preview(m) {
    const now = performance.now();
    if (now - lastPreview < 35) return;
    lastPreview = now;
    const src = playBuffer(renderPreview(m, song.lead));
    src.start();
  }

  $("btnPlay").addEventListener("click", togglePlay);
  /* ---------- moving the playhead ---------- */
  // Drag on the bar ruler, the handle or the playhead line to place it.
  // It snaps to 16th notes; hold Alt for free placement. While playing, it jumps live.
  function seek(step) {
    cursorStep = clamp(step, 0, totalSteps() - 0.001);
    if (source && cached.key === serialize()) startSource(cached.mix, cursorStep);
    else if (wantPlaying) startPlayback(cursorStep);
    else placePlayhead(cursorStep);
  }
  function stepFromPointer(e) {
    const rect = grid.getBoundingClientRect();
    const raw = (e.clientX - rect.left + scroller.scrollLeft) / CW;
    return e.altKey ? raw : Math.round(raw);
  }
  let scrubbing = false, lastSeek = 0;
  function startScrub(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    scrubbing = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("scrubbing");
    seek(stepFromPointer(e));
  }
  function moveScrub(e) {
    if (!scrubbing) return;
    const step = stepFromPointer(e);
    placePlayhead(clamp(step, 0, totalSteps()));
    // Restarting audio on every mouse move would stutter, so limit live seeks while playing.
    const now = performance.now();
    if (!source) cursorStep = clamp(step, 0, totalSteps() - 0.001);
    else if (now - lastSeek > 90) { lastSeek = now; seek(step); }
  }
  function endScrub(e) {
    if (!scrubbing) return;
    scrubbing = false;
    document.body.classList.remove("scrubbing");
    seek(stepFromPointer(e));
  }
  for (const el of [rulerWrap, playhead]) {
    el.addEventListener("pointerdown", startScrub);
    el.addEventListener("pointermove", moveScrub);
    el.addEventListener("pointerup", endScrub);
    el.addEventListener("pointercancel", endScrub);
  }
  $("btnRewind").addEventListener("click", () => { seek(0); scroller.scrollLeft = 0; });
  keys.addEventListener("pointerdown", e => {
    const rect = keys.getBoundingClientRect();
    preview(HI - Math.floor((e.clientY - rect.top) / RH));
  });

  /* ---------- note editing with the mouse ---------- */
  let drag = null;

  function pointerInfo(e) {
    const rect = grid.getBoundingClientRect();
    const x = e.clientX - rect.left + scroller.scrollLeft, y = e.clientY - rect.top + scroller.scrollTop;
    return { x, y, step: Math.floor(x / CW), m: clamp(HI - Math.floor(y / RH), LO, HI) };
  }
  function noteAt(x, m) {
    for (let i = song.notes.length - 1; i >= 0; i--) {
      const n = song.notes[i];
      if (n.m === m && x >= n.s * CW && x < (n.s + n.d) * CW) return n;
    }
    return null;
  }

  grid.addEventListener("contextmenu", e => e.preventDefault());

  grid.addEventListener("pointerdown", e => {
    const p = pointerInfo(e);
    hoverStep = Math.max(0, p.step);
    const hit = noteAt(p.x, p.m);

    if (e.button === 2) { // right-click deletes; right-drag erases everything it passes over
      grid.setPointerCapture(e.pointerId);
      drag = { mode: "erase", before: serialize(), last: p };
      if (hit && selected.has(hit) && selected.size > 1) eraseNotes([...selected]);
      else eraseAlong(p, p);
      document.body.classList.add("erasing");
      return;
    }
    if (e.button !== 0) return;
    grid.setPointerCapture(e.pointerId);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const before = serialize();

    if (hit) {
      if (additive) { selected.has(hit) ? selected.delete(hit) : selected.add(hit); }
      else if (!selected.has(hit)) { selected = new Set([hit]); }
      const edge = p.x > (hit.s + hit.d) * CW - Math.min(8, hit.d * CW / 3);
      const group = selected.has(hit) ? [...selected] : [hit];
      drag = { mode: edge ? "resize" : "move", start: p, anchor: hit, before, lastM: hit.m,
        origin: group.map(n => ({ n, s: n.s, m: n.m, d: n.d })) };
      preview(hit.m);
    } else if (e.shiftKey) {
      drag = { mode: "box", start: p, before, base: new Set(selected) };
    } else {
      const note = { m: p.m, s: Math.max(0, p.step), d: +$("noteLen").value };
      song.notes.push(note);
      selected = new Set([note]);
      drag = { mode: "move", start: p, anchor: note, before, lastM: note.m, origin: [{ n: note, s: note.s, m: note.m, d: note.d }] };
      preview(note.m);
    }
    drawGrid();
  });

  grid.addEventListener("pointermove", e => {
    const p = pointerInfo(e);
    if (!drag) {
      hoverStep = Math.max(0, p.step);
      const hit = noteAt(p.x, p.m);
      grid.style.cursor = !hit ? "crosshair" : p.x > (hit.s + hit.d) * CW - Math.min(8, hit.d * CW / 3) ? "ew-resize" : "grab";
      return;
    }
    if (drag.mode === "erase") {
      eraseAlong(drag.last, p);
      drag.last = p;
      return;
    }
    const dStep = p.step - drag.start.step, dM = p.m - drag.start.m;
    if (drag.mode === "move") {
      const minS = Math.min(...drag.origin.map(o => o.s));
      const minM = Math.min(...drag.origin.map(o => o.m)), maxM = Math.max(...drag.origin.map(o => o.m));
      const ds = Math.max(dStep, -minS), dm = clamp(dM, LO - minM, HI - maxM);
      for (const o of drag.origin) { o.n.s = o.s + ds; o.n.m = o.m + dm; }
      if (drag.anchor.m !== drag.lastM) { drag.lastM = drag.anchor.m; preview(drag.anchor.m); }
      grid.style.cursor = "grabbing";
    } else if (drag.mode === "resize") {
      for (const o of drag.origin) o.n.d = Math.max(1, o.d + dStep);
    } else if (drag.mode === "box") {
      const x0 = Math.min(drag.start.x, p.x), x1 = Math.max(drag.start.x, p.x);
      const y0 = Math.min(drag.start.y, p.y), y1 = Math.max(drag.start.y, p.y);
      Object.assign(boxEl.style, { left: x0 + "px", top: y0 + "px", width: x1 - x0 + "px", height: y1 - y0 + "px" });
      boxEl.hidden = false;
      selected = new Set(drag.base);
      for (const n of song.notes) {
        const nx0 = n.s * CW, nx1 = (n.s + n.d) * CW, ny0 = (HI - n.m) * RH, ny1 = ny0 + RH;
        if (nx1 > x0 && nx0 < x1 && ny1 > y0 && ny0 < y1) selected.add(n);
      }
    }
    requestDraw();
  });

  // Delete every note under the path from a to b (sampled finely so fast swipes don't skip notes).
  function eraseAlong(a, b) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / 3));
    const hits = new Set();
    for (let i = 0; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps;
      const n = noteAt(x, clamp(HI - Math.floor(y / RH), LO, HI));
      if (n) hits.add(n);
    }
    if (hits.size) eraseNotes([...hits]);
  }
  function eraseNotes(list) {
    const gone = new Set(list);
    song.notes = song.notes.filter(n => !gone.has(n));
    for (const n of list) selected.delete(n);
    requestDraw();
  }

  function endDrag() {
    if (!drag) return;
    document.body.classList.remove("erasing");
    boxEl.hidden = true;
    if (drag.mode !== "box" && serialize() !== drag.before) {
      undoStack.push(drag.before);
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
      changed();
    }
    drag = null;
    drawGrid();
  }
  grid.addEventListener("pointerup", endDrag);
  grid.addEventListener("pointercancel", endDrag);
  grid.addEventListener("dblclick", e => {
    const p = pointerInfo(e);
    const hit = noteAt(p.x, p.m);
    if (hit) { pushUndo(); removeNotes([hit]); }
  });

  /* ---------- selection commands ---------- */
  function removeNotes(list) {
    const gone = new Set(list);
    song.notes = song.notes.filter(n => !gone.has(n));
    for (const n of list) selected.delete(n);
    changed();
  }
  function copySelection(cut) {
    if (!selected.size) return toast("Select some notes first");
    const list = [...selected];
    const minS = Math.min(...list.map(n => n.s));
    clipboard = list.map(n => ({ m: n.m, s: n.s - minS, d: n.d }));
    try { localStorage.setItem("yatovoid.musicbox.clipboard", JSON.stringify(clipboard)); } catch (e) { /* optional */ }
    if (cut) { pushUndo(); removeNotes(list); }
    toast(`${cut ? "Cut" : "Copied"} ${list.length} note${list.length > 1 ? "s" : ""}`);
  }
  function pasteAt(step) {
    if (!clipboard.length) {
      try { clipboard = JSON.parse(localStorage.getItem("yatovoid.musicbox.clipboard")) || []; } catch (e) { clipboard = []; }
    }
    if (!clipboard.length) return toast("Nothing copied yet");
    pushUndo();
    const pasted = clipboard.map(c => ({ m: c.m, s: step + c.s, d: c.d }));
    song.notes.push(...pasted);
    selected = new Set(pasted);
    changed();
    toast(`Pasted ${pasted.length} note${pasted.length > 1 ? "s" : ""} at bar ${Math.floor(step / stepsPerBar()) + 1}`);
  }
  function duplicate() {
    if (!selected.size) return toast("Select some notes first");
    const list = [...selected];
    const minS = Math.min(...list.map(n => n.s)), maxE = Math.max(...list.map(n => n.s + n.d));
    clipboard = list.map(n => ({ m: n.m, s: n.s - minS, d: n.d }));
    pasteAt(maxE);
  }
  function nudge(dStep, dM) {
    if (!selected.size) return false;
    const list = [...selected];
    if (list.some(n => n.s + dStep < 0 || n.m + dM < LO || n.m + dM > HI)) return true;
    pushUndo();
    for (const n of list) { n.s += dStep; n.m += dM; }
    if (dM) preview(list[0].m);
    changed();
    return true;
  }

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", e => {
    const tag = e.target.tagName;
    const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === "s") { e.preventDefault(); saveToLibrary(); return; }
    if (e.key === "Escape") { closePanels(); selected.clear(); drawGrid(); return; }
    if (inField) return;
    if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); togglePlay(); return; }
    if (e.key === "Home") { e.preventDefault(); seek(0); scroller.scrollLeft = 0; return; }
    if (mod && key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (key === "y" || (key === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && key === "a") { e.preventDefault(); selected = new Set(song.notes); drawGrid(); return; }
    if (mod && key === "c") { e.preventDefault(); copySelection(false); return; }
    if (mod && key === "x") { e.preventDefault(); copySelection(true); return; }
    if (mod && key === "v") { e.preventDefault(); pasteAt(hoverStep); return; }
    if (mod && key === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selected.size) { e.preventDefault(); pushUndo(); removeNotes([...selected]); }
      return;
    }
    const arrows = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[e.key]) {
      const [ds, dm] = arrows[e.key];
      const big = e.shiftKey;
      if (nudge(ds * (big ? STEPS_PER_BEAT : 1), dm * (big ? 12 : 1))) e.preventDefault();
    }
  });

  /* ---------- library ---------- */
  const library = () => store.get(LIBRARY_KEY, {});

  function saveToLibrary() {
    const lib = library();
    lib[song.name] = { ...JSON.parse(serialize()), savedAt: Date.now() };
    if (!store.set(LIBRARY_KEY, lib)) return toast("Couldn't save: this browser is blocking storage for the page.", true);
    lastSavedJson = serialize();
    updateTitle();
    renderLibrary();
    toast(`Saved “${song.name}” in this browser`);
  }

  function loadSong(data, message) {
    if (wantPlaying) stopPlayback();
    pushUndo();
    song = cleanSong(data);
    selected.clear();
    cursorStep = 0;
    lastSavedJson = data && data.savedAt ? serialize() : "";
    refreshAll();
    scroller.scrollLeft = 0;
    toast(message + " · Ctrl+Z to go back");
  }

  function renderLibrary() {
    const lib = library();
    const names = Object.keys(lib).sort((a, b) => (lib[b].savedAt || 0) - (lib[a].savedAt || 0));
    const list = $("songList");
    list.innerHTML = "";
    $("libraryEmpty").hidden = names.length > 0;
    for (const name of names) {
      const s = lib[name];
      const li = document.createElement("li");
      const date = s.savedAt ? new Date(s.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      li.innerHTML = `<div class="song-meta"><strong></strong><span>${s.bars} bars · ${s.bpm} BPM · ${s.beatsPerBar}/4 · ${date}</span></div>
        <div class="song-actions"><button type="button" data-act="open">Open</button><button type="button" data-act="delete" class="danger">Delete</button></div>`;
      li.querySelector("strong").textContent = name;
      li.querySelector('[data-act="open"]').addEventListener("click", () => { loadSong(library()[name], `Opened “${name}”`); closePanels(); });
      const del = li.querySelector('[data-act="delete"]');
      del.addEventListener("click", () => {
        if (del.dataset.armed) {
          const l = library();
          delete l[name];
          store.set(LIBRARY_KEY, l);
          renderLibrary();
          toast(`Deleted “${name}”`);
        } else {
          del.dataset.armed = "1";
          del.textContent = "Confirm delete";
          setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "Delete"; } }, 3000);
        }
      });
      list.appendChild(li);
    }
    const demos = $("demoList");
    demos.innerHTML = "";
    for (const demo of DEMO_SONGS) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="song-meta"><strong></strong><span>${demo.bars} bars · ${demo.bpm} BPM · ${demo.beatsPerBar}/4 · ${VOICES[demo.lead].label}</span></div>
        <div class="song-actions"><button type="button">Open</button></div>`;
      li.querySelector("strong").textContent = demo.name;
      li.querySelector("button").addEventListener("click", () => { loadSong(demo, `Opened example “${demo.name}”`); closePanels(); });
      demos.appendChild(li);
    }
  }

  /* ---------- panels ---------- */
  function togglePanel(id, button) {
    const panel = $(id);
    const open = panel.hidden;
    closePanels();
    panel.hidden = !open;
    $(button).setAttribute("aria-expanded", String(open));
    if (open && id === "library") renderLibrary();
  }
  function closePanels() {
    for (const [p, b] of [["library", "btnLibrary"], ["help", "btnHelp"]]) { $(p).hidden = true; $(b).setAttribute("aria-expanded", "false"); }
  }
  $("btnLibrary").addEventListener("click", () => togglePanel("library", "btnLibrary"));
  $("btnHelp").addEventListener("click", () => togglePanel("help", "btnHelp"));
  for (const btn of document.querySelectorAll("[data-close]")) btn.addEventListener("click", closePanels);

  /* ---------- file buttons ---------- */
  const fileBase = () => (song.name || "song").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "song";
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Downloaded " + filename);
  }

  $("btnNew").addEventListener("click", () => loadSong(blankSong(), "Started a new song"));
  $("btnSave").addEventListener("click", saveToLibrary);
  $("btnImport").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (/\.midi?$/i.test(file.name)) {
        loadSong(importMidi(await file.arrayBuffer(), file.name), `Imported “${file.name}”`);
      } else {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.notes)) throw new Error("This file doesn't contain a song.");
        loadSong(data, `Imported “${file.name}”`);
      }
    } catch (err) {
      toast("Couldn't import that file. " + (err.message || ""), true);
    }
  });
  $("btnExportJson").addEventListener("click", () =>
    download(new Blob([JSON.stringify({ format: "yatovoid-music-box", version: 1, ...song }, null, 2)], { type: "application/json" }), fileBase() + ".json"));
  $("btnExportMidi").addEventListener("click", () => download(new Blob([exportMidi(song)], { type: "audio/midi" }), fileBase() + ".mid"));
  $("btnExportWav").addEventListener("click", () => {
    toast("Rendering audio…");
    const name = fileBase() + ".wav";
    getMix().then(mix => download(encodeWav(mix), name));
  });

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(text, isError) {
    const el = $("toast");
    el.textContent = text;
    el.dataset.kind = isError ? "error" : "info";
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2600);
  }

  /* ---------- start ---------- */
  function init() {
    readPalette();
    fillVoiceSelect();
    const draft = store.get(DRAFT_KEY, null);
    song = cleanSong(draft || DEMO_SONGS[0]);
    const saved = library()[song.name];
    lastSavedJson = saved ? JSON.stringify(cleanSong(saved)) : "";
    $("zoom").value = CW;
    refreshAll();
    scroller.scrollTop = (HI - 86) * RH;
    try { clipboard = JSON.parse(localStorage.getItem("yatovoid.musicbox.clipboard")) || []; } catch (e) { clipboard = []; }

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const repaint = () => { readPalette(); drawKeys(); drawGrid(); };
    scheme.addEventListener ? scheme.addEventListener("change", repaint) : scheme.addListener(repaint);
    new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    scroller.addEventListener("scroll", requestDraw, { passive: true });
    // The visible area changes when the window resizes or a panel opens or closes.
    new ResizeObserver(() => { resizeView(); drawGrid(); }).observe(scroller);
  }
  init();
})();
