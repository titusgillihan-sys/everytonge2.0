"use strict";
/**
 * THE METRIC. Conflicts are a fraction of CONSTRAINED transitions. A flat
 * melody step or a flat tone transition is neither a pass nor a fail, and a
 * melody that avoids the test cannot win it.
 */
const test = require("node:test");
const assert = require("node:assert");
const scorer = require("../scorer.js");
const { search } = require("../search.js");
const { forLanguage } = require("../tone/index.js");
const { StubModelProvider } = require("../providers/model.js");

const vi = forLanguage("vi");
const syl = (text) => vi.syllabify(text);
const melody = (id, phrases) => ({ id, name: id, community: "-", license: "PD", sourceUrl: "-", verified: false,
  phrases: phrases.map((midi) => ({ midi })) });
const passage = (text) => ({ id: "p", reference: "P 1:1", text, verses: [{ n: 1, text }], chunks: [],
  version: { id: "V", name: "v", language: "vi", copyright: "-" } });

test("a flat melody step is unconstrained, not a pass", () => {
  const s = syl("là Đấng"); // huyền (2->1) then sắc (3->5): the voice steps up by 2
  const flat = scorer.scoreSetting(s, [60, 60], [[0, 0], [1, 1]]);
  assert.strictEqual(flat.totals.transitions, 1);
  assert.strictEqual(flat.totals.constrained, 0);
  assert.strictEqual(flat.totals.rate, null, "nothing tested means no rate, not a perfect rate");
  const up = scorer.scoreSetting(s, [60, 64], [[0, 0], [1, 1]]);
  assert.deepStrictEqual([up.totals.constrained, up.totals.conflicts, up.totals.rate], [1, 0, 0]);
  const down = scorer.scoreSetting(s, [64, 60], [[0, 0], [1, 1]]);
  assert.deepStrictEqual([down.totals.constrained, down.totals.conflicts, down.totals.rate], [1, 1, 1]);
});

test("a flat tone transition is unconstrained whatever the melody does", () => {
  const s = syl("tôi an"); // ngang (3->3) then ngang: the voice does not move
  const r = scorer.scoreSetting(s, [60, 67], [[0, 0], [1, 1]]);
  assert.strictEqual(r.rows[1].constrained, false);
  assert.strictEqual(r.totals.constrained, 0);
});

test("ranking: fewest conflicts first; engaged transitions only break ties", () => {
  const T = (constrained, conflicts, severity) =>
    scorer.withRate({ transitions: 8, voiceMoving: 8, constrained, conflicts, severity, secondary: 0 });
  const untested = T(0, 0, 0);
  const few = T(4, 0, 0);
  const many = T(7, 0, 0);
  const oneMiss = T(7, 1, 2);
  const dodged = T(2, 0, 0); // engages 2 of 8 voice-moving transitions: below the floor
  assert.strictEqual(untested.net, 0);
  assert.ok(scorer.compareTotals(few, untested) < 0, "four passes beat nothing tested");
  assert.ok(scorer.compareTotals(many, few) < 0, "at equal rate, seven passes beat four");
  assert.ok(scorer.compareTotals(many, oneMiss) < 0, "seven passes beat six passes and a miss");
  assert.ok(scorer.compareTotals(few, oneMiss) < 0, "zero conflicts on four beats one conflict on seven");
  const twoOfMany = T(8, 2, 2);
  const oneOfFew = T(4, 1, 4);
  assert.ok(scorer.compareTotals(oneOfFew, twoOfMany) < 0, "one conflict beats two even at a worse rate and higher severity");
  assert.ok(scorer.compareTotals(oneMiss, dodged) < 0, "but a setting below the coverage floor ranks after any eligible one");
});

test("hiding a conflict on a repeated note gains no more than resolving it, and hiding a pass costs a point", () => {
  const s = vi.syllabify("là Đấng chăn"); // huyền, sắc, ngang: voice up 2 into Đấng, down 2 into chăn
  // one note per syllable, melody down then down: conflict into Đấng, pass into chăn
  const honest = scorer.scoreSetting(s, [67, 64, 60], [[0, 0], [1, 1], [2, 2]]);
  assert.deepStrictEqual([honest.totals.conflicts, honest.totals.passes, honest.totals.net], [1, 1, 0]);
  // park the conflicting transition on a shared note: conflict gone, pass kept
  const parkedConflict = scorer.scoreSetting(s, [67, 67, 60], [[0, 0], [0, 0], [2, 2]]);
  assert.deepStrictEqual([parkedConflict.totals.conflicts, parkedConflict.totals.passes, parkedConflict.totals.net], [0, 1, 1]);
  // park the PASSING transition instead: same rate, fewer constrained, so it ranks below the honest one-per-note setting on a fitting tune
  const parkedPass = scorer.scoreSetting(s, [64, 67, 67], [[0, 0], [1, 1], [1, 1]]);
  assert.deepStrictEqual([parkedPass.totals.conflicts, parkedPass.totals.passes, parkedPass.totals.net], [0, 1, 1]);
  const fitting = scorer.scoreSetting(s, [64, 67, 64], [[0, 0], [1, 1], [2, 2]]);
  assert.deepStrictEqual([fitting.totals.conflicts, fitting.totals.passes, fitting.totals.net], [0, 2, 2]);
  assert.ok(scorer.compareTotals(fitting.totals, parkedPass.totals) < 0);
});

test("a drone is ineligible; a moving tune is eligible", () => {
  const drone = melody("drone", [[60, 60, 60, 60, 60, 60, 60, 60]]);
  const chant = melody("chant", [[60, 60, 62, 60, 60, 60, 62, 60]]); // moves, but only over 2 semitones
  const tune = melody("tune", [[60, 65, 69, 65, 69, 67, 65, 62]]);
  assert.strictEqual(scorer.melodyEligibility(drone).eligible, false);
  assert.strictEqual(scorer.melodyEligibility(chant).eligible, false);
  assert.strictEqual(scorer.melodyEligibility(tune).eligible, true);
});

test("search reports a drone as ineligible, never as the best setting", async () => {
  const drone = melody("drone", [[60, 60, 60, 60, 60, 60, 60, 60, 60]]);
  const tune = melody("tune", [[60, 65, 69, 65, 69, 67, 65, 62, 60]]);
  const out = await search({
    passage: passage("Đức Giê-hô-va là Đấng chăn giữ tôi:"), melodies: [drone, tune], toneModule: vi,
    baselineMelodyId: "tune", model: new StubModelProvider(),
  });
  const droneAttempt = out.attempts.find((a) => a.melodyId === "drone");
  assert.strictEqual(droneAttempt.ineligible, true);
  assert.ok(out.results.every((r) => r.melodyId !== "drone"));
});

test("a setting that parks its tone changes on repeated notes is ineligible", () => {
  // Melody with a repeated pair everywhere the tone would move. Both moving
  // fraction and range pass the melody floor, but the SETTING fails coverage.
  const t = scorer.withRate({ transitions: 10, voiceMoving: 8, constrained: 3, conflicts: 0, severity: 0, secondary: 0 });
  const e = scorer.settingEligibility(t);
  assert.strictEqual(e.eligible, false);
  assert.match(e.reasons[0], /only 3 of the 8/);
  // Flat-voice transitions are not held against the melody.
  const flatText = scorer.withRate({ transitions: 10, voiceMoving: 4, constrained: 3, conflicts: 0, severity: 0, secondary: 0 });
  assert.strictEqual(scorer.settingEligibility(flatText).eligible, true);
});
