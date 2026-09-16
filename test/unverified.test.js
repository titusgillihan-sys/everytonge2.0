"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { collectUnverified, dependenciesOf } = require("../unverified.js");
const checklist = require("../cli/checklist.js");
const { FixtureScriptureProvider } = require("../providers/scripture.js");
const { StubModelProvider } = require("../providers/model.js");
const { loadMelodies } = require("../melodies.js");
const { forLanguage } = require("../tone/index.js");
const { search } = require("../search.js");
const { render } = require("../cli/report.js");

test("every unverified value in the data is in the registry, highest impact first", () => {
  const e = collectUnverified();
  const ids = e.map((x) => x.id);
  for (const t of ["ngang", "huyen", "sac", "hoi", "nga", "nang"]) assert.ok(ids.includes(`tone.vi.${t}`));
  assert.ok(ids.includes("tone.vi.region"));
  for (const m of loadMelodies()) { assert.ok(ids.includes(`melody.${m.id}.community`)); assert.ok(ids.includes(`melody.${m.id}.notes`)); }
  assert.ok(ids.includes("chunker.break-penalties"));
  assert.ok(ids.includes("scorer.thresholds"));
  for (let i = 1; i < e.length; i++) assert.ok(e[i].impact <= e[i - 1].impact);
  for (const x of e) { assert.strictEqual(x.status, "unverified"); assert.ok(x.ask && x.title && x.file); }
});

test("the report lists the unverified values the result depends on", async () => {
  const passage = await new FixtureScriptureProvider().getPassage("VI1925", "PSA.23.1-2");
  const out = await search({ passage, melodies: loadMelodies(), toneModule: forLanguage("vi"), baselineMelodyId: "new-britain", model: new StubModelProvider() });
  const deps = dependenciesOf(out);
  const ids = deps.map((d) => d.id);
  assert.ok(ids.includes("tone.vi.sac") && ids.includes("tone.vi.ngang"), "tones present in the passage");
  assert.ok(!ids.includes("tone.vi.zzz"));
  assert.ok(ids.includes(`melody.${out.results[0].melodyId}.notes`), "the winning melody");
  assert.ok(ids.includes("melody.new-britain.notes"), "the baseline melody");
  assert.ok(ids.includes("chunker.break-penalties") && ids.includes("scorer.thresholds"));
  const text = render(out, loadMelodies());
  assert.match(text, /UNVERIFIED VALUES THIS RESULT DEPENDS ON/);
  for (const d of deps) assert.ok(text.includes(d.title), `report names: ${d.title}`);
});

test("VALIDATION.md is generated, current, and names every required item", async () => {
  const generated = await checklist.main();
  const committed = fs.readFileSync(path.join(__dirname, "..", "VALIDATION.md"), "utf8");
  assert.strictEqual(committed, generated, "VALIDATION.md is stale: run `node cli/checklist.js > VALIDATION.md`");
  for (const must of ["ma, mà, má, mả, mã, mạ", "hỏi", "Stille Nacht", "New Britain", "Ode to Joy", "break-penalties", "scoring-thresholds", "John 3:16", "không bị | hư mất", "FLAGGED, severity"]) {
    assert.ok(generated.includes(must), `checklist mentions ${must}`);
  }
  assert.ok(generated.split("\n").length < 140, "one page");
});
