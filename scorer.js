"use strict";
/**
 * scorer.js — the contrary-motion scorer, language-agnostic.
 *
 * Input is syllables carrying Chao pitch shapes ([start, end] on a 1–5
 * scale, from a tone module) and MIDI notes; the scorer never sees a
 * language. The transition rule is the same one as motionConflict() in
 * shared.js, which the web UI uses keyed by Mandarin tone number.
 * test/scorer-parity.test.js holds the two equal on every Mandarin case, and
 * test/scorer-transition.test.js (the contract test) runs against this file
 * with SCORER=../scorer.js.
 *
 * TRANSITION SEMANTICS (settled, see CLAUDE.md): the transition into
 * syllable i runs from the LAST note of syllable i-1's span to the FIRST note
 * of syllable i's span. Phrase boundaries are breaths: no transition is
 * scored across them, which is why each chunk is scored on its own.
 *
 * Two conflict types, never folded together:
 *   primary   — contrary motion between adjacent syllables (the number that
 *               matters, per Ladd & Kirby 2020).
 *   secondary — within-syllable melisma: the melody moves across a syllable's
 *               own span against the direction of that tone's own contour.
 */

const fs = require("node:fs");
const path = require("node:path");

const MELODY_STEP = { up: 1, same: 0, down: -1 };

/** Thresholds that decide what counts as a constrained transition (data/scoring-thresholds.json, unverified). */
function loadThresholds(file = path.join(__dirname, "data", "scoring-thresholds.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
const THRESHOLDS = loadThresholds();

/** How the speaking voice moves into a syllable: from where the previous
 *  tone ends to where this one starts. null when either side has no shape. */
function speechInterval(prevShape, shape) {
  if (!prevShape || !shape) return null;
  return shape[0] - prevShape[1];
}

function melodyDirection(fromMidi, toMidi, thresholds = THRESHOLDS) {
  if (fromMidi === null || fromMidi === undefined || toMidi === null || toMidi === undefined) return null;
  const d = toMidi - fromMidi;
  if (Math.abs(d) < thresholds.melodyMoveSemitones) return "same";
  return d > 0 ? "up" : "down";
}

function directionLabel(signed) {
  if (signed === null || signed === undefined) return null;
  if (signed > 0) return "up";
  if (signed < 0) return "down";
  return "same";
}

/**
 * Melody up while speech goes down (or vice versa) = contrary = flagged.
 *
 * A transition is CONSTRAINED only when both the melody and the voice move
 * (by at least the table thresholds). A flat melody step, a flat tone
 * transition, or a syllable with no shape creates no constraint: it is
 * neither a pass nor a fail, and it is reported as unconstrained so that a
 * melody which avoids the test cannot win it.
 *
 * `severity` is how far the voice has to move against the tune (1–4).
 */
function transitionConflict(prevShape, shape, direction, thresholds = THRESHOLDS) {
  const speech = speechInterval(prevShape, shape);
  const melody = MELODY_STEP[direction];
  const melodyMoves = melody !== undefined && melody !== 0;
  const speechMoves = speech !== null && Math.abs(speech) >= thresholds.speechMoveLevels;
  if (!melodyMoves || !speechMoves) {
    return { voiceMoves: speechMoves, constrained: false, contrary: false, severity: 0, speech, melody: melody ?? null };
  }
  const contrary = Math.sign(speech) !== Math.sign(melody);
  return { voiceMoves: true, constrained: true, contrary, severity: contrary ? Math.abs(speech) : 0, speech, melody };
}

/**
 * Secondary conflict: a syllable sung across several notes whose overall
 * movement (first note -> last note) opposes the tone's own contour.
 */
function melismaConflict(shape, firstMidi, lastMidi) {
  if (!shape || firstMidi === lastMidi) return { contrary: false, severity: 0, own: null, melody: 0 };
  const own = shape[1] - shape[0];
  const melody = Math.sign(lastMidi - firstMidi);
  if (own === 0) return { contrary: false, severity: 0, own, melody };
  const contrary = Math.sign(own) !== melody;
  return { contrary, severity: contrary ? Math.abs(own) : 0, own, melody };
}

/**
 * Score one chunk under one alignment.
 *
 *   syllables — [{ text, tone, shape, unknown, ... }] from a tone module
 *   notes     — MIDI numbers for one melody phrase
 *   alignment — spans[i] = [firstNoteIndex, lastNoteIndex] for syllable i
 *
 * Returns per-syllable rows plus totals. The first syllable has nothing
 * before it and can never be flagged.
 */
function scoreSetting(syllables, notes, alignment) {
  if (alignment.length !== syllables.length) {
    throw new Error(`alignment has ${alignment.length} spans for ${syllables.length} syllables`);
  }
  const rows = syllables.map((syl, i) => {
    const [first, last] = alignment[i];
    const prev = i > 0 ? alignment[i - 1] : null;
    const fromMidi = prev ? notes[prev[1]] : null;
    const toMidi = notes[first];
    const direction = prev ? melodyDirection(fromMidi, toMidi) : null;
    const prevShape = i > 0 ? syllables[i - 1].shape : null;
    const t = prev
      ? transitionConflict(prevShape, syl.shape, direction)
      : { constrained: false, contrary: false, severity: 0, speech: null };
    const m = melismaConflict(syl.shape, notes[first], notes[last]);
    return {
      index: i,
      text: syl.text,
      tone: syl.tone,
      label: syl.label,
      shape: syl.shape,
      unknown: !!syl.unknown,
      trailing: syl.trailing || "",
      noteSpan: [first, last],
      notes: notes.slice(first, last + 1),
      melody: direction,
      speech: t.speech,
      speechDir: directionLabel(t.speech),
      transition: prev !== null,
      voiceMoves: !!t.voiceMoves,
      constrained: t.constrained,
      contrary: t.contrary,
      severity: t.severity,
      melisma: { notes: last - first + 1, contrary: m.contrary, severity: m.severity },
    };
  });
  const totals = withRate(
    rows.reduce(
      (acc, r) => {
        if (r.transition) acc.transitions += 1;
        if (r.voiceMoves) acc.voiceMoving += 1;
        if (r.constrained) acc.constrained += 1;
        if (r.contrary) {
          acc.conflicts += 1;
          acc.severity += r.severity;
        }
        if (r.melisma.contrary) acc.secondary += 1;
        return acc;
      },
      { transitions: 0, voiceMoving: 0, constrained: 0, conflicts: 0, severity: 0, secondary: 0 }
    )
  );
  return { rows, totals };
}

/**
 * Derived numbers:
 *   passes = constrained transitions sung WITH the voice
 *   rate   = conflicts / constrained (null when nothing was constrained:
 *            nothing tested, nothing passed)
 *   net    = passes - conflicts
 */
function withRate(t) {
  const passes = t.constrained - t.conflicts;
  return { ...t, passes, net: passes - t.conflicts, rate: t.constrained > 0 ? t.conflicts / t.constrained : null };
}

/**
 * Ranking key, best first (FEWEST CONFLICTS FIRST):
 *   1. eligible before ineligible — the coverage floor is the gate: a
 *      setting whose melody engages too few of the voice-moving transitions
 *      dodged the test (settingEligibility)
 *   2. fewest contrary transitions — a setting with zero conflicts mangles
 *      nothing; one with two mangles two words
 *   3. total primary severity
 *   4. secondary (melisma) conflicts
 *   5. MORE constrained transitions, as a tie-break only. Extra engaged
 *      transitions describe how hard the melody worked, not how well the
 *      result serves the singer, so they never compensate for a conflict.
 *
 * `rate` and `net` are still reported.
 */
function compareTotals(a, b) {
  const ea = settingEligibility(a).eligible ? 0 : 1;
  const eb = settingEligibility(b).eligible ? 0 : 1;
  return ea - eb || a.conflicts - b.conflicts || a.severity - b.severity || a.secondary - b.secondary || b.constrained - a.constrained;
}

function addTotals(a, b) {
  return withRate({
    transitions: a.transitions + b.transitions,
    voiceMoving: a.voiceMoving + b.voiceMoving,
    constrained: a.constrained + b.constrained,
    conflicts: a.conflicts + b.conflicts,
    severity: a.severity + b.severity,
    secondary: a.secondary + b.secondary,
  });
}

const ZERO_TOTALS = Object.freeze(withRate({ transitions: 0, voiceMoving: 0, constrained: 0, conflicts: 0, severity: 0, secondary: 0 }));

/**
 * MELODIC-INTEREST FLOOR. Pushed to its limit, a contrary-motion score says
 * the ideal melody is a drone, so a melody must move enough to be eligible
 * at all. Movement is measured across all phrases: the fraction of adjacent
 * note pairs that move, and the pitch range in semitones.
 */
function melodyMovement(melody) {
  let pairs = 0;
  let moving = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of melody.phrases) {
    for (let i = 0; i < p.midi.length; i++) {
      lo = Math.min(lo, p.midi[i]);
      hi = Math.max(hi, p.midi[i]);
      if (i > 0) {
        pairs += 1;
        if (melodyDirection(p.midi[i - 1], p.midi[i]) !== "same") moving += 1;
      }
    }
  }
  return { pairs, moving, movingFraction: pairs ? moving / pairs : 0, rangeSemitones: hi - lo };
}

function melodyEligibility(melody, thresholds = THRESHOLDS) {
  const m = melodyMovement(melody);
  const reasons = [];
  if (m.movingFraction < thresholds.minMovingFraction) {
    reasons.push(`only ${m.moving} of ${m.pairs} note steps move (${m.movingFraction.toFixed(2)} < ${thresholds.minMovingFraction})`);
  }
  if (m.rangeSemitones < thresholds.minRangeSemitones) {
    reasons.push(`range ${m.rangeSemitones} semitones < ${thresholds.minRangeSemitones}`);
  }
  return { eligible: reasons.length === 0, movement: m, reasons };
}

/**
 * A setting is eligible only if the melody engages enough of the transitions
 * where the VOICE moves. Transitions where the voice is flat (ngang after
 * ngang, for instance) can never be constrained by any melody, so they are
 * not in the denominator; a drone still engages none of them.
 */
function settingEligibility(totals, thresholds = THRESHOLDS) {
  const fraction = totals.voiceMoving ? totals.constrained / totals.voiceMoving : 0;
  const eligible = fraction >= thresholds.minConstrainedFraction;
  return {
    eligible,
    constrainedFraction: fraction,
    reasons: eligible
      ? []
      : [`the melody engages only ${totals.constrained} of the ${totals.voiceMoving} transitions where the voice moves (${fraction.toFixed(2)} < ${thresholds.minConstrainedFraction})`],
  };
}

/**
 * Adapter so the scorer contract test (test/scorer-transition.test.js) can be
 * pointed at this file: Mandarin notes { tone, direction } in, the same row
 * shape shared.js produces out. Shapes come from the Mandarin tone module.
 */
function analyzeNotes(notes) {
  const { CHAO_TONES, effectiveTones } = require("./shared.js");
  const eff = effectiveTones(notes);
  const shapeOf = (t) => (CHAO_TONES[t] && CHAO_TONES[t].shape) || null;
  return notes.map((note, i) => {
    const unknown = note.tone === null || note.tone === undefined;
    const t =
      unknown || i === 0
        ? { contrary: false, severity: 0, speech: null }
        : transitionConflict(shapeOf(eff[i - 1]), shapeOf(eff[i]), note.direction);
    return {
      ...note,
      index: i,
      unknown,
      effTone: eff[i],
      sandhi: !unknown && eff[i] !== note.tone,
      speech: t.speech,
      speechDir: directionLabel(t.speech),
      match: !t.contrary,
      severity: t.severity,
    };
  });
}

module.exports = {
  MELODY_STEP,
  THRESHOLDS,
  ZERO_TOTALS,
  loadThresholds,
  withRate,
  melodyMovement,
  melodyEligibility,
  settingEligibility,
  speechInterval,
  melodyDirection,
  directionLabel,
  transitionConflict,
  melismaConflict,
  scoreSetting,
  compareTotals,
  addTotals,
  analyzeNotes,
};
