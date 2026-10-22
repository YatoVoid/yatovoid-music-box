/*
 * YatoVoid Music Box - example songs.
 * Written compactly as "Chord:Note beats, Note beats | next bar ...".
 * Use "-" as the note name for a rest.
 */
"use strict";

const DEMO_SONGS = (() => {
  function build(name, bpm, beatsPerBar, lead, text) {
    const bars = text.split("|").map(s => s.trim());
    const chords = [], notes = [];
    bars.forEach((bar, i) => {
      const [chord, melody] = bar.split(":");
      chords.push(chord.trim());
      let pos = 0;
      for (const item of melody.split(",")) {
        const [note, beats] = item.trim().split(/\s+/);
        if (note !== "-") {
          notes.push({ m: noteNumber(note), s: i * beatsPerBar * 4 + Math.round(pos * 4), d: Math.round(beats * 4) });
        }
        pos += +beats;
      }
    });
    return { name, bpm, beatsPerBar, bars: bars.length, lead, volumes: { lead: 1, bass: 1, chords: 1 }, chords, notes };
  }

  const waltzA = "F:C5 1,F5 1,A5 1|Bb:G5 2,F5 1|F:A5 1,C6 1,A5 1|C:G5 3|F:F5 1,A5 1,C6 1|Bb:D6 1.5,C6 .5,Bb5 1";
  const waltz = [
    waltzA + "|F:A5 1,G5 1,F5 1|C7:E5 2,G5 1",
    waltzA + "|C7:G5 1,E5 1,C5 1|F:F5 3",
    "Bb:D6 2,C6 1|F:A5 2,F5 1|Gm7:Bb5 1,A5 1,G5 1|C:E5 2,G5 1|Bb:F5 1,Bb5 1,D6 1|F:C6 1.5,A5 .5,F5 1|G7:B5 1,A5 1,G5 1|C7:G5 2,E5 1",
    waltzA + "|F:A5 1,G5 1,F5 1|C7:E5 2,G5 1",
  ].join("|");

  const radio = "G:D5 1,B4 .5,D5 .5,G5 2|E7:G#5 1.5,E5 .5,D5 1,B4 1|A7:C#5 1,E5 1,G5 1,A5 1|D7:F#5 2,E5 1,D5 1|" +
    "G:D5 1,B4 .5,D5 .5,G5 1,B5 1|G:A5 1.5,G5 .5,E5 2|C:E5 1,G5 1,C6 1,A5 1|D7:F#5 1,A5 1,C6 1,A5 1";

  const cottage = "C:E5 1,G5 1,E5 .5,D5 .5,C5 1|Am7:A4 1.5,C5 .5,E5 2|Dm7:F5 1,E5 .5,D5 .5,A4 2|G7:G4 1,B4 1,D5 1,F5 1|" +
    "C:E5 1,G5 1,C6 1.5,B5 .5|E7:G#5 1,E5 1,B4 2|F:A5 1,G5 .5,F5 .5,E5 1,D5 1|G7:D5 1,B4 1,G4 2";

  return [
    build("Parlor Waltz", 104, 3, "musicbox", waltz),
    build("Old Radio", 108, 4, "square", radio),
    build("Cottage Evening", 92, 4, "soft", cottage),
  ];
})();
