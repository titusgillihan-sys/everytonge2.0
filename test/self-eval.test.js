"use strict";
/**
 * Runs the hand-built self-eval set (eval/cases.json). Expectations there
 * were written before running and are never changed to match behaviour. A
 * case may carry `knownFailing`, which records that its failure is known and
 * what it reveals; this wrapper fails when a case's outcome differs from
 * that record in either direction, so a fix and a regression both show up.
 * The pass rate is printed with the run.
 */
const test = require("node:test");
const assert = require("node:assert");
const { runAll, format } = require("../eval/run.js");

test("self-eval set: outcomes match the recorded expectations (not a benchmark)", async () => {
  const results = await runAll();
  console.log(format(results));
  const unexpected = results.filter((r) => (r.knownFailing ? r.pass : !r.pass));
  assert.deepStrictEqual(
    unexpected.map((r) => `${r.id}: ${r.pass ? "now PASSES; remove knownFailing" : "FAILS"}`),
    [],
    "cases whose outcome differs from the record"
  );
  assert.ok(results.length >= 20);
});
