"use strict";
/**
 * Mandarin tone module — the same interface as tone/vietnamese.js, wrapped
 * around the existing dictionary reader and the CHAO_TONES table in shared.js.
 *
 * This module exists as the proof that the language abstraction holds: the
 * scorer, alignment and search never see which language they are scoring.
 *
 * Third-tone sandhi (3 + 3 is spoken 2 + 3) is applied here, at the tone
 * boundary, using the same effectiveTones() the web UI uses, so `shape` is
 * the SPOKEN shape while `tone` stays the citation tone for display.
 */
const { CHAO_TONES, effectiveTones } = require("../shared.js");
const { lookupLine } = require("../tone-dictionary.js");

/**
 * Characters needed by the fixture passages that the curated web-UI
 * dictionary (tone-dictionary.js) does not carry. Standard readings; an entry
 * here is looked up only when the main dictionary has no entry.
 */
const SUPPLEMENT = {
  "和": { pinyin: "hé", tone: 2 },
  "华": { pinyin: "huá", tone: 2 },
  "必": { pinyin: "bì", tone: 4 },
  "致": { pinyin: "zhì", tone: 4 },
  "缺": { pinyin: "quē", tone: 1 },
  "乏": { pinyin: "fá", tone: 2 },
  "使": { pinyin: "shǐ", tone: 3 },
  "躺": { pinyin: "tǎng", tone: 3 },
  "卧": { pinyin: "wò", tone: 4 },
  "青": { pinyin: "qīng", tone: 1 },
  "草": { pinyin: "cǎo", tone: 3 },
  "地": { pinyin: "dì", tone: 4 },
  "上": { pinyin: "shàng", tone: 4 },
  "领": { pinyin: "lǐng", tone: 3 },
  "可": { pinyin: "kě", tone: 3 },
  "歇": { pinyin: "xiē", tone: 1 },
  "边": { pinyin: "biān", tone: 1 },
  "者": { pinyin: "zhě", tone: 3 },
};

const TONES = {
  1: { shape: CHAO_TONES[1].shape, label: "1st (high level)" },
  2: { shape: CHAO_TONES[2].shape, label: "2nd (rising)" },
  3: { shape: CHAO_TONES[3].shape, label: "3rd (low dipping)" },
  4: { shape: CHAO_TONES[4].shape, label: "4th (falling)" },
  5: { shape: null, label: "neutral" },
};

const CJK = /[\u4e00-\u9fff]/u;

/** Split text into CJK characters, attaching any punctuation that follows a character to it. */
function tokenize(text) {
  const tokens = [];
  for (const ch of String(text)) {
    if (CJK.test(ch)) tokens.push({ hanzi: ch, trailing: "" });
    else if (/\s/u.test(ch)) continue;
    else if (tokens.length) tokens[tokens.length - 1].trailing += ch;
  }
  return tokens;
}

function syllabify(text) {
  const tokens = tokenize(text);
  const raw = lookupLine(tokens.map((t) => t.hanzi).join("")).map((s) =>
    s.tone === null && SUPPLEMENT[s.hanzi] ? { hanzi: s.hanzi, ...SUPPLEMENT[s.hanzi] } : s
  );
  const eff = effectiveTones(raw);
  return raw.map((s, i) => {
    const unknown = s.tone === null || s.tone === undefined;
    const entry = unknown ? null : TONES[eff[i]];
    return {
      text: s.hanzi,
      pinyin: s.pinyin,
      tone: unknown ? null : s.tone,
      effectiveTone: unknown ? null : eff[i],
      sandhi: !unknown && eff[i] !== s.tone,
      shape: entry && entry.shape ? entry.shape : null,
      unknown,
      label: unknown
        ? "unknown (not in dictionary)"
        : eff[i] !== s.tone
          ? `${TONES[s.tone].label} -> ${entry.label.split(" ")[0]} (sandhi)`
          : entry.label,
      trailing: tokens[i].trailing,
      joinedToNext: false,
    };
  });
}

module.exports = {
  id: "zh",
  name: "Mandarin",
  file: "tone/mandarin.js",
  TONES,
  SUPPLEMENT,
  syllabify,
  separator: "",
};
