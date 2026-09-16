#!/usr/bin/env node
"use strict";
/**
 * eval/run.js — runs the hand-built self-eval set (eval/cases.json).
 *
 * This is NOT a benchmark: 22 hand-built cases whose expectations were
 * written from the design before they were run. Failures are reported, not
 * tuned away. `node eval/run.js` prints the table; test/self-eval.test.js
 * wraps it.
 */
const fs = require("node:fs");
const path = require("node:path");
const { FixtureScriptureProvider } = require("../providers/scripture.js");
const { StubModelProvider, cached } = require("../providers/model.js");
const { loadMelodies, validate } = require("../melodies.js");
const { forLanguage } = require("../tone/index.js");
const { search, searchTranslations } = require("../search.js");
const { render } = require("../cli/report.js");
const { rejoin } = require("../chunker.js");
const { MAX_MELISMA, MAX_SHARE } = require("../align.js");

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "cases.json"), "utf8")).cases;

function customMelody(m) {
  return validate({ id: m.id, name: m.name, community: "test", license: "test", sourceUrl: "test", verified: false,
    confidenceNote: "test", phrases: m.phrases.map((midi) => ({ midi })) }, `${m.id} (inline)`);
}

function inlinePassage(p) {
  return Object.freeze({ id: `inline:${p.text}`, reference: p.label || "test text", passageKey: null,
    version: { id: "TEST", name: `Test text (${p.label || "not Scripture"})`, language: p.language, copyright: "Test text, not Scripture." },
    text: p.text, textSource: "test-text", verses: [{ n: 0, text: p.text }], chunks: [] });
}

async function runCase(c) {
  const scripture = new FixtureScriptureProvider({ includeSynthetic: !!(c.passage.includeSynthetic) });
  const library = loadMelodies();
  const melodies = (c.melodies === "all" ? library : library.filter((m) => c.melodies.includes(m.id))).concat((c.extraMelodies || []).map(customMelody));
  const model = cached(new StubModelProvider());
  let out;
  let toneModule;
  if (c.passage.key) {
    toneModule = forLanguage(c.passage.language);
    const versions = c.passage.versions === "all" ? await scripture.versionsWithPassage(c.passage.key, c.passage.language) : c.passage.versions.map((id) => scripture.version(id));
    const passages = [];
    for (const v of versions) passages.push(await scripture.getPassage(v.id, c.passage.key));
    out = await searchTranslations({ passages, baselineVersionId: c.baselineVersion, melodies, toneModule, baselineMelodyId: c.baseline, model, chunking: c.chunking });
  } else {
    let passage;
    if (c.passage.fixture) {
      const meta = (await scripture.listPassages()).find((p) => p.id === c.passage.fixture);
      passage = await scripture.getPassage(meta.versionId, meta.id);
    } else {
      passage = inlinePassage(c.passage);
    }
    toneModule = forLanguage(passage.version.language);
    out = await search({ passage, melodies, toneModule, baselineMelodyId: c.baseline, model, chunking: c.chunking });
  }
  return { out, toneModule, melodies };
}

/** Evaluate each expectation; returns [{ key, expected, actual, ok }]. */
function check(c, { out, toneModule, melodies }) {
  const b = out.baseline.totals;
  const w = out.results[0] || null;
  const rows = [];
  const push = (key, expected, actual, ok) => rows.push({ key, expected, actual, ok });
  const winnerBreaksInside = (needle) => {
    if (!w) return false;
    const syl = w.chunks.flatMap((ch) => ch.rows);
    const words = needle.split(" ");
    for (const bIdx of (w.chunking && w.chunking.breaks) || []) {
      // a break at bIdx sits between syl[bIdx-1] and syl[bIdx]
      for (let k = 0; k + 1 < words.length; k++) {
        if (syl[bIdx - 1] && syl[bIdx] && syl[bIdx - 1].text === words[k] && syl[bIdx].text === words[k + 1]) return true;
      }
    }
    return false;
  };
  for (const [key, expected] of Object.entries(c.expect)) {
    switch (key) {
      case "improves": push(key, expected, out.results.length > 0, (out.results.length > 0) === expected); break;
      case "results": push(key, expected, out.results.length, out.results.length === expected); break;
      case "hasFailure": push(key, expected, !!out.failure, !!out.failure === expected); break;
      case "language": push(key, expected, out.language, out.language === expected); break;
      case "baselineConflicts": push(key, expected, b.conflicts, b.conflicts === expected); break;
      case "baselineConflictsGt": push(key, `> ${expected}`, b.conflicts, b.conflicts > expected); break;
      case "baselineSeverity": push(key, expected, b.severity, b.severity === expected); break;
      case "baselineConstrained": push(key, expected, b.constrained, b.constrained === expected); break;
      case "winnerConflictsLte": push(key, `<= ${expected}`, w ? w.totals.conflicts : "no winner", !!w && w.totals.conflicts <= expected); break;
      case "winnerMelody": push(key, expected, w ? w.melodyId : "no winner", !!w && w.melodyId === expected); break;
      case "winnerNotMelody": push(key, `not ${expected}`, w ? w.melodyId : "no winner", !!w && w.melodyId !== expected); break;
      case "winnerVersion": push(key, expected, w ? w.versionId : "no winner", !!w && w.versionId === expected); break;
      case "winnerChunksGt": push(key, `> ${expected}`, w ? w.chunks.length : "no winner", !!w && w.chunks.length > expected); break;
      case "ineligible": {
        const got = out.attempts.filter((a) => a.ineligible).map((a) => a.melodyId);
        push(key, expected, got, expected.every((id) => got.includes(id)));
        break;
      }
      case "allInfeasible": {
        const ok = out.attempts.length > 0 && out.attempts.every((a) => a.infeasible);
        push(key, expected, out.attempts.map((a) => (a.infeasible ? "infeasible" : "feasible")), ok === expected);
        break;
      }
      case "failureMentions": push(key, expected, out.failure ? out.failure.explanation.slice(0, 80) + "…" : "no failure", !!out.failure && out.failure.explanation.includes(expected)); break;
      case "noBreakInside": push(key, `no break in "${expected}"`, winnerBreaksInside(expected) ? "BREAKS inside" : "intact", !winnerBreaksInside(expected)); break;
      case "noBreakInsideHyphenated": {
        const settings = [out.baseline, ...out.results].filter((s) => s.chunking && s.chunking.breaks);
        const bad = settings.some((s) => { const syl = s.chunks.flatMap((ch) => ch.rows); return s.chunking.breaks.some((i) => syl[i - 1] && syl[i - 1].joinedToNext); });
        push(key, expected, !bad, !bad === expected);
        break;
      }
      case "verbatim": {
        const passage = out.passage;
        const ok = [out.baseline, ...out.results].every((s) => s.chunks.map((ch) => ch.text).join(toneModule.separator) === passage.text);
        push(key, expected, ok, ok === expected);
        break;
      }
      case "boundsRespected": {
        let ok = true;
        for (const s of out.results) for (const ch of s.chunks) {
          const onNote = {};
          for (const r of ch.rows) { if (r.notes.length > MAX_MELISMA) ok = false; if (r.noteSpan[0] === r.noteSpan[1]) onNote[r.noteSpan[0]] = (onNote[r.noteSpan[0]] || 0) + 1; }
          if (Object.values(onNote).some((n) => n > MAX_SHARE)) ok = false;
        }
        push(key, expected, ok, ok === expected);
        break;
      }
      case "reportContains": push(key, expected, render(out, melodies).includes(expected), render(out, melodies).includes(expected) === true); break;
      default: push(key, expected, "UNKNOWN EXPECTATION KEY", false);
    }
  }
  return rows;
}

async function runAll() {
  const results = [];
  for (const c of CASES) {
    let checks;
    try {
      checks = check(c, await runCase(c));
    } catch (err) {
      checks = [{ key: "run", expected: "no error", actual: err.message, ok: false }];
    }
    results.push({ id: c.id, why: c.why, knownFailing: c.knownFailing || null, checks, pass: checks.every((x) => x.ok) });
  }
  return results;
}

function format(results) {
  const L = [];
  const passed = results.filter((r) => r.pass).length;
  L.push(`SELF-EVAL — hand-built set of ${results.length} cases, NOT a benchmark. Expectations were written before running.`);
  L.push(`Pass rate: ${passed}/${results.length} (${((100 * passed) / results.length).toFixed(0)}%)`);
  L.push("");
  for (const r of results) {
    L.push(`${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.knownFailing ? "  [known failing]" : ""}`);
    for (const c of r.checks) if (!c.ok) L.push(`      ${c.key}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`);
    if (!r.pass && r.knownFailing) L.push(`      reveals: ${r.knownFailing}`);
  }
  return L.join("\n");
}

if (require.main === module) {
  runAll().then((r) => { console.log(format(r)); process.exitCode = r.every((x) => x.pass) ? 0 : 1; });
}
module.exports = { runAll, format, CASES };
