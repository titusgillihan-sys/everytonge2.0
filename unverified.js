"use strict";
/**
 * unverified.js — THE UNVERIFIED SURFACE.
 *
 * Every value a native speaker or a musician would need to confirm lives in
 * a data table with a status flag; this module collects them into one list
 * so the report can show which of them a given result depends on and the
 * checklist (cli/checklist.js) can ask about all of them in impact order.
 *
 * Entry: { id, category, owner, impact (5 = affects every verdict), title,
 *          assumed, ask, context, status }
 *   owner: "speaker" (a fluent Vietnamese speaker can answer in a call),
 *          "musician" (needs a score or a hymnal), "both".
 */
const path = require("node:path");
const { loadMelodies, noteName } = require("./melodies.js");
const { loadPenalties } = require("./chunker.js");
const { loadThresholds } = require("./scorer.js");

function collectUnverified({ toneModule = require("./tone/vietnamese.js"), melodies = loadMelodies(), penalties = loadPenalties(), thresholds = loadThresholds() } = {}) {
  const entries = [];

  // 1. Tone pitch table — affects every verdict.
  const V = toneModule.VALIDATION;
  if (V && V.status !== "verified") {
    for (const [tone, t] of Object.entries(toneModule.TONES)) {
      const q = V.tones[tone] || {};
      entries.push({
        id: `tone.${toneModule.id}.${tone}`, category: "tone", owner: "speaker", impact: 5,
        title: `${t.label}: pitch path ${t.shape[0]} -> ${t.shape[1]} on a 1-5 scale`,
        assumed: q.assumed, ask: q.ask, context: `Say "${q.example}" on its own, then in a short phrase.`,
        status: V.status, file: toneModule.file,
      });
    }
    entries.push({ id: `tone.${toneModule.id}.region`, category: "tone", owner: "speaker", impact: 5,
      title: "Which regional accent the table describes", assumed: "Northern (Hanoi)", ask: V.region,
      context: "Southern speakers merge hỏi and ngã; the table would need a second row set.", status: V.status, file: toneModule.file });
  }

  // 2. Melodies — community claims (speaker) and note lists (musician).
  for (const m of melodies) {
    if (m.verified) continue;
    entries.push({ id: `melody.${m.id}.community`, category: "melody", owner: "speaker", impact: 4,
      title: `${m.name}: is it a tune this community knows?`, assumed: m.community,
      ask: `Do you know this tune? Hum the first line. What is it called in Vietnamese, and is it sung in church?`,
      context: `License: ${m.license}. Source: ${m.sourceUrl}.`, status: "unverified", file: `data/melodies/${m.id}.json` });
    entries.push({ id: `melody.${m.id}.notes`, category: "melody", owner: "musician", impact: 3,
      title: `${m.name}: note list (${m.phrases.length} phrases), confidence ${m.confidence}`,
      assumed: m.phrases.map((p, i) => `${i + 1}. ${p.midi.map(noteName).join(" ")}${p.hint ? `  (${p.hint})` : ""}`).join("\n"),
      ask: `Check each phrase against a score at ${m.sourceUrl}. ${m.confidenceNote}`,
      context: `Key ${m.key || "?"}, meter ${m.meter || "?"}. A wrong note changes which syllables are flagged.`, status: "unverified", file: `data/melodies/${m.id}.json` });
  }

  // 3. Break penalties.
  if (penalties.status !== "verified") {
    entries.push({ id: "chunker.break-penalties", category: "break-penalty", owner: "speaker", impact: 3,
      title: "Where a singer may breathe: the break-penalty table", assumed: penalties.validation.assumed,
      ask: penalties.validation.ask.join(" "), context: "Only the ratios matter; they decide where the chunker splits a passage into sung phrases.",
      status: penalties.status, file: "data/break-penalties.json" });
  }

  // 4. Scoring thresholds.
  if (thresholds.status !== "verified") {
    entries.push({ id: "scorer.thresholds", category: "threshold", owner: "musician", impact: 2,
      title: "Melodic-interest floor and coverage floor", assumed: thresholds.validation.assumed,
      ask: thresholds.validation.ask.join(" "), context: "These decide when a tune or a setting is ruled ineligible instead of ranked.",
      status: thresholds.status, file: "data/scoring-thresholds.json" });
  }

  return entries.sort((a, b) => b.impact - a.impact || a.id.localeCompare(b.id));
}

/** The subset of entries a specific search result depends on, with the concrete facts that make them matter. */
function dependenciesOf(out, entries = collectUnverified()) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const used = [];
  const winner = out.results && out.results[0];
  const settings = [out.baseline, winner].filter(Boolean);

  const tones = new Set();
  const breakClasses = {};
  for (const s of settings) {
    for (const c of s.chunks) for (const r of c.rows) if (r.tone) tones.add(r.tone);
    if (s.chunking && s.chunking.source === "dp" && s.chunking.breaks) {
      const syl = s.chunks.flatMap((c) => c.rows);
      for (const b of s.chunking.breaks) {
        const t = syl[b - 1] && syl[b - 1].trailing;
        const cls = t ? "punctuation" : "no punctuation";
        breakClasses[cls] = (breakClasses[cls] || 0) + 1;
      }
    }
  }
  for (const t of tones) {
    const e = byId.get(`tone.${out.language}.${t}`);
    if (e) used.push({ ...e, because: `syllables with this tone appear in the passage` });
  }
  const region = byId.get(`tone.${out.language}.region`);
  if (region) used.push({ ...region, because: "every tone verdict assumes this accent" });
  for (const s of settings) {
    for (const suffix of ["community", "notes"]) {
      const e = byId.get(`melody.${s.melodyId}.${suffix}`);
      if (e && !used.some((u) => u.id === e.id)) used.push({ ...e, because: s === winner ? "the winning setting uses this melody" : "the baseline uses this melody" });
    }
  }
  if (Object.keys(breakClasses).length) {
    const e = byId.get("chunker.break-penalties");
    if (e) used.push({ ...e, because: `breaks placed: ${Object.entries(breakClasses).map(([k, v]) => `${v} at ${k}`).join(", ")}` });
  }
  const th = byId.get("scorer.thresholds");
  if (th) used.push({ ...th, because: "eligibility and what counts as a constrained transition" });
  return used;
}

module.exports = { collectUnverified, dependenciesOf };
