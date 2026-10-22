/*
 * YatoVoid Music Box - sound engine.
 * Renders a song to a mono Float32Array at 44.1 kHz using simple 8-bit style
 * oscillators (pulse waves and a 4-bit stepped triangle), then adds a soft
 * echo and a gentle low-pass. The result loops cleanly: anything that rings
 * past the end of the song wraps around to the beginning.
 */
"use strict";

// Wrapped in a function so the same code can also be started inside a background worker.
function synthLib(global) {
"use strict";

const SR = 44100;
const STEPS_PER_BEAT = 4; // the grid is in 16th notes

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
const PITCH_CLASS = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };

const hz = m => 440 * 2 ** ((m - 69) / 12);
const noteName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
function noteNumber(name) {
  const match = /^([A-G](?:#|b)?)(-?\d)$/.exec(name);
  if (!match) throw new Error("Bad note name: " + name);
  return 12 * (+match[2] + 1) + PITCH_CLASS[match[1]];
}

/* ---------- chords ---------- */
const CHORD_ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const QUALITIES = {
  "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10], "6": [0, 4, 7, 9], sus4: [0, 5, 7], dim: [0, 3, 6],
};

/** "Gm7" -> { root: 43, intervals: [0,3,7,10] } or null for an empty / unknown chord. */
function parseChord(name) {
  if (!name) return null;
  const match = /^([A-G](?:#|b)?)(.*)$/.exec(name);
  if (!match || !(match[1] in PITCH_CLASS) || !(match[2] in QUALITIES)) return null;
  const pc = PITCH_CLASS[match[1]];
  return { root: pc >= 7 ? 36 + pc : 48 + pc, intervals: QUALITIES[match[2]] };
}

/**
 * Accompaniment for every bar that has a chord: a bass note on the downbeat
 * (plus the fifth on beat 3 in 4/4) and short two-note chord stabs on the
 * remaining beats. Shared by the audio renderer and the MIDI exporter.
 * Returns [{ part: "bass" | "chord", beat, length, m }] with times in beats.
 */
function backingPattern(song) {
  const events = [];
  const bpb = song.beatsPerBar;
  const bassBeats = bpb === 4 ? [0, 2] : [0];
  song.chords.forEach((name, bar) => {
    const chord = parseChord(name);
    if (!chord || bar >= song.bars) return;
    const start = bar * bpb;
    for (let beat = 0; beat < bpb; beat++) {
      if (bassBeats.includes(beat)) {
        const m = (beat === 0 ? chord.root : chord.root + 7) - 12;
        events.push({ part: "bass", beat: start + beat, length: 0.9, m });
      } else {
        for (const iv of chord.intervals.slice(1, 3)) {
          events.push({ part: "chord", beat: start + beat, length: 0.4, m: chord.root + iv + 12 });
        }
      }
    }
  });
  return events;
}

/* ---------- oscillators ---------- */
const pulseShape = duty => ph => (ph < duty ? 1 : -1);
const tri4 = ph => Math.round((2 - 4 * Math.abs(ph - 0.5)) * 7.5) / 7.5 - 1; // NES-style 4-bit triangle

function addOsc(out, offset, f, n, shape, amp, env, vib = 0) {
  const limit = Math.min(n, out.length - offset);
  let ph = 0;
  for (let i = 0; i < limit; i++) {
    let freq = f;
    if (vib) {
      const t = i / SR;
      freq = f * (1 + vib * Math.sin(2 * Math.PI * 5 * t) * Math.min(1, Math.max(0, (t - 0.3) / 0.3)));
    }
    ph += freq / SR;
    out[offset + i] += shape(ph % 1) * amp * env(i);
  }
}

/** Attack / decay / sustain envelope of n samples followed by an r-sample release. */
function adsr(n, a, d, s, r) {
  const A = Math.min(Math.max(1, (a * SR) | 0), n);
  const D = Math.max(1, (d * SR) | 0);
  const level = i => (i < A ? (A > 1 ? i / (A - 1) : 1) : i < A + D ? 1 + (s - 1) * (i - A) / D : s);
  const end = level(n - 1);
  return i => (i < n ? level(i) : end * Math.max(0, 1 - (i - n) / r));
}

const bell = decay => {
  const click = 0.002 * SR;
  return i => Math.exp(-i / (decay * SR)) * (i < click ? i / click : 1);
};

/** Melody voices. Each adds one note of n samples (plus its ring-out) into out. */
const VOICES = {
  musicbox: {
    label: "Music box",
    play(out, o, f, n) {
      addOsc(out, o, f, (1.4 * SR) | 0, pulseShape(0.125), 1, bell(0.45));
      const r = (0.12 * SR) | 0;
      addOsc(out, o, f, n + r, pulseShape(0.5), 0.25, adsr(n, 0.01, 0.2, 0.6, r), 0.004);
    },
  },
  square: {
    label: "Square",
    play(out, o, f, n) {
      const r = (0.12 * SR) | 0;
      addOsc(out, o, f, n + r, pulseShape(0.25), 0.8, adsr(n, 0.01, 0.2, 0.6, r), 0.004);
    },
  },
  soft: {
    label: "Soft flute",
    play(out, o, f, n) {
      const r = (0.25 * SR) | 0;
      const env = adsr(n, 0.04, 0.4, 0.75, r);
      addOsc(out, o, f, n + r, tri4, 0.75, env, 0.005);
      addOsc(out, o, f, n + r, pulseShape(0.5), 0.25, env, 0.005);
    },
  },
  chip: {
    label: "Thin chip",
    play(out, o, f, n) {
      const r = (0.06 * SR) | 0;
      addOsc(out, o, f, n + r, pulseShape(0.125), 0.7, adsr(n, 0.005, 0.1, 0.7, r));
    },
  },
};

/* ---------- mixing ---------- */
function lowpassLoop(x, cutoff) {
  // Run the filter twice around the loop so the end flows into the start.
  const a = Math.exp(-2 * Math.PI * cutoff / SR);
  let acc = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < x.length; i++) {
      acc = (1 - a) * x[i] + a * acc;
      if (pass) x[i] = acc;
    }
  }
}

function songLengthSamples(song) {
  return Math.max(1, Math.round(song.bars * song.beatsPerBar * (60 / song.bpm) * SR));
}

/** Render a whole song as a loop with no gap at the end. */
function renderSong(song) {
  const beat = 60 / song.bpm;
  const stepSec = beat / STEPS_PER_BEAT;
  const totalSteps = song.bars * song.beatsPerBar * STEPS_PER_BEAT;
  const L = songLengthSamples(song);
  const T = 3 * SR;
  const lead = new Float32Array(L + T), bass = new Float32Array(L + T), chord = new Float32Array(L + T);
  const voice = (VOICES[song.lead] || VOICES.musicbox).play;

  for (const n of song.notes) {
    if (n.s >= totalSteps) continue;
    const offset = Math.round(n.s * stepSec * SR);
    const len = Math.max(1, (n.d * stepSec * SR * 0.9) | 0);
    voice(lead, offset, hz(n.m), len);
  }

  for (const ev of backingPattern(song)) {
    const offset = Math.round(ev.beat * beat * SR);
    const n = (ev.length * beat * SR) | 0;
    if (ev.part === "bass") addOsc(bass, offset, hz(ev.m), n + 400, tri4, 1, adsr(n, 0.005, 0.15, 0.6, 400));
    else addOsc(chord, offset, hz(ev.m), n + 600, pulseShape(0.25), 0.5, adsr(n, 0.005, 0.1, 0.5, 600));
  }

  const wrap = x => {
    const y = x.slice(0, L);
    for (let i = 0; i < T; i++) y[i % L] += x[L + i];
    return y;
  };
  const ld = wrap(lead), bs = wrap(bass), cd = wrap(chord);
  const v = song.volumes || {};
  const vl = v.lead ?? 1, vb = v.bass ?? 1, vc = v.chords ?? 1;
  const delay = Math.round(beat * SR);
  const mix = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    let wet = ld[i];
    for (let k = 1; k <= 3; k++) wet += ld[(((i - delay * k) % L) + L) % L] * 0.2 ** k;
    mix[i] = 0.4 * vl * wet + 0.28 * vb * bs[i] + 0.09 * vc * cd[i];
  }
  lowpassLoop(mix, 7000);

  let peak = 0;
  for (let i = 0; i < L; i++) peak = Math.max(peak, Math.abs(mix[i]));
  if (peak > 0) for (let i = 0; i < L; i++) mix[i] *= 0.8 / peak;
  return mix;
}

/** A short single note for auditioning while editing. */
function renderPreview(m, voiceName) {
  const out = new Float32Array((0.8 * SR) | 0);
  (VOICES[voiceName] || VOICES.musicbox).play(out, 0, hz(m), (0.25 * SR) | 0);
  for (let i = 0; i < out.length; i++) out[i] *= 0.25;
  return out;
}

/** 16-bit mono PCM WAV file. */
function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([buf], { type: "audio/wav" });
}

Object.assign(global, {
  SR, STEPS_PER_BEAT, NOTE_NAMES, hz, noteName, noteNumber, CHORD_ROOTS, QUALITIES,
  parseChord, backingPattern, VOICES, renderSong, renderPreview, encodeWav,
});
}

synthLib(self);
