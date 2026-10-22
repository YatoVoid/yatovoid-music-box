/*
 * YatoVoid Music Box - Standard MIDI File import and export.
 * Export writes a type-1 file with three tracks: Melody, Chords and Bass.
 * Import reads any type-0 or type-1 file and turns every non-drum note into
 * melody notes on the 16th-note grid.
 */
"use strict";

const MIDI_TPB = 480;

function exportMidi(song) {
  const ticksPerStep = MIDI_TPB / STEPS_PER_BEAT;
  const totalSteps = song.bars * song.beatsPerBar * STEPS_PER_BEAT;
  const ascii = s => Array.from(s, c => c.charCodeAt(0) & 127);
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const vlq = n => { const b = [n & 127]; while ((n >>>= 7) > 0) b.unshift((n & 127) | 128); return b; };

  function track(name, channel, program, notes, meta = []) {
    const ev = meta.map(bytes => [0, 0, bytes]);
    const label = ascii(name);
    ev.push([0, 0, [0xff, 0x03, ...vlq(label.length), ...label]]);
    if (channel != null) ev.push([0, 1, [0xc0 | channel, program]]);
    for (const [tick, length, m, vel] of notes) {
      ev.push([tick, 3, [0x90 | channel, m, vel]]);
      ev.push([tick + length, 2, [0x80 | channel, m, 0]]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const data = [];
    let last = 0;
    for (const [tick, , bytes] of ev) { data.push(...vlq(tick - last), ...bytes); last = tick; }
    data.push(0, 0xff, 0x2f, 0);
    return [...ascii("MTrk"), ...u32(data.length), ...data];
  }

  const tempo = Math.round(60e6 / song.bpm);
  const meta = [
    [0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255],
    [0xff, 0x58, 4, song.beatsPerBar, 2, 24, 8],
  ];
  const melody = song.notes.filter(n => n.s < totalSteps)
    .map(n => [n.s * ticksPerStep, n.d * ticksPerStep, n.m, 96]);
  const backing = backingPattern(song);
  const part = name => backing.filter(e => e.part === name)
    .map(e => [Math.round(e.beat * MIDI_TPB), Math.round(e.length * MIDI_TPB), e.m, name === "bass" ? 80 : 60]);

  const tracks = [
    track(song.name || "Melody", 0, 10, melody, meta), // 10 = Music Box
    track("Chords", 1, 80, part("chord")),              // 80 = Square Lead
    track("Bass", 2, 38, part("bass")),                 // 38 = Synth Bass
  ];
  const header = [...ascii("MThd"), ...u32(6), 0, 1, 0, tracks.length, (MIDI_TPB >> 8) & 255, MIDI_TPB & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}

function importMidi(arrayBuffer, fileName) {
  const d = new DataView(arrayBuffer);
  let p = 0;
  const tag = () => String.fromCharCode(d.getUint8(p), d.getUint8(p + 1), d.getUint8(p + 2), d.getUint8(p + 3));
  const vlq = () => { let n = 0, b; do { b = d.getUint8(p++); n = (n << 7) | (b & 127); } while (b & 128); return n; };

  if (d.byteLength < 14 || tag() !== "MThd") throw new Error("This file isn't a MIDI file.");
  const headerLen = d.getUint32(p + 4);
  const trackCount = d.getUint16(p + 10);
  let division = d.getUint16(p + 12);
  if (division & 0x8000) division = MIDI_TPB; // SMPTE timing: fall back to a sensible default
  p = 8 + headerLen;

  let tempo = null, beatsPerBar = null;
  const notes = [];
  for (let t = 0; t < trackCount && p + 8 <= d.byteLength; t++) {
    if (tag() !== "MTrk") break;
    const end = Math.min(p + 8 + d.getUint32(p + 4), d.byteLength);
    p += 8;
    let tick = 0, status = 0;
    const open = new Map();
    while (p < end) {
      tick += vlq();
      if (d.getUint8(p) & 0x80) status = d.getUint8(p++);
      if (status === 0xff) {
        const type = d.getUint8(p++), len = vlq();
        if (type === 0x51 && tempo == null) tempo = (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2);
        if (type === 0x58 && beatsPerBar == null) beatsPerBar = d.getUint8(p);
        p += len;
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else {
        const kind = status & 0xf0, channel = status & 15;
        const a = d.getUint8(p++);
        const b = kind === 0xc0 || kind === 0xd0 ? 0 : d.getUint8(p++);
        if (channel === 9) continue; // skip drums
        const key = channel * 128 + a;
        if (kind === 0x90 && b > 0) {
          if (!open.has(key)) open.set(key, tick);
        } else if (kind === 0x80 || kind === 0x90) {
          if (open.has(key)) { notes.push({ m: a, start: open.get(key), end: tick }); open.delete(key); }
        }
      }
    }
    p = end;
  }
  if (!notes.length) throw new Error("No notes were found in this MIDI file.");

  const ticksPerStep = division / STEPS_PER_BEAT;
  const bpb = beatsPerBar === 3 || beatsPerBar === 6 ? 3 : 4;
  const fit = m => { while (m < 48) m += 12; while (m > 96) m -= 12; return m; };
  const result = notes.map(n => ({
    m: fit(n.m),
    s: Math.round(n.start / ticksPerStep),
    d: Math.max(1, Math.round((n.end - n.start) / ticksPerStep)),
  }));
  const lastStep = Math.max(...result.map(n => n.s + n.d));
  const bars = Math.min(64, Math.max(1, Math.ceil(lastStep / (bpb * STEPS_PER_BEAT))));
  return {
    name: (fileName || "Imported song").replace(/\.midi?$/i, ""),
    bpm: tempo ? Math.round(60e6 / tempo) : 120,
    beatsPerBar: bpb,
    bars,
    lead: "musicbox",
    volumes: { lead: 1, bass: 1, chords: 1 },
    chords: new Array(bars).fill(""),
    notes: result,
  };
}
