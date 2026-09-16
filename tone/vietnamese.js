"use strict";
/**
 * Vietnamese tone module.
 *
 * Every tone module exposes the same interface (see tone/index.js):
 *
 *   id, name            — language code and display name
 *   TONES               — the pitch table: tone id -> { shape: [start, end], label }
 *   syllabify(text)     — plain text -> [{ text, tone, shape, unknown, label }]
 *
 * The scorer, alignment and search only ever read `shape`. Adding a language
 * is a new file with this interface plus its data tables; nothing downstream
 * changes.
 *
 * Vietnamese tone is written in ordinary orthography as one of five combining
 * marks; a syllable with none is ngang (level). Extraction is therefore
 * deterministic parsing: NFD-normalise, scan for the five tone marks, and
 * ignore the letter-shape diacritics (circumflex â ê ô, breve ă, horn ơ ư),
 * which are not tone. Syllables are space-delimited, and the 1926 translation
 * hyphenates transliterated names (Giê-hô-va, Đa-vít), so hyphens split too.
 *
 * No sandhi: Vietnamese has no tone sandhi rule worth modelling here, so the
 * shape used for scoring is the citation shape.
 */

/** Combining marks that carry tone. Anything else combining is ignored. */
const TONE_MARKS = {
  "\u0300": "huyen", // grave       à
  "\u0301": "sac",   // acute       á
  "\u0309": "hoi",   // hook above  ả
  "\u0303": "nga",   // tilde       ã
  "\u0323": "nang",  // dot below   ạ
};

/**
 * THE PITCH TABLE — UNVALIDATED, PENDING A NATIVE SPEAKER.
 *
 * Chao start/end levels on the 1–5 scale for the six tones, reduced from the
 * usual Hanoi citation values (ngang 33, huyền 21, sắc 35, hỏi 313, ngã 3ˀ5,
 * nặng 2ˀ1). Only two endpoints are kept because the scorer looks at where
 * one tone ends and where the next begins. That reduction throws away the
 * interior of the contour and the glottal features, and it bakes in these
 * judgment calls:
 *
 *   - hỏi is given a low end (3 -> 1). In careful Hanoi speech it rises
 *     again (313); in running speech the rise is usually lost. If the rise
 *     matters for singing, change the end to 3.
 *   - ngã is treated as sắc for pitch (3 -> 5), ignoring the glottal break.
 *   - nặng is treated as huyền for pitch (2 -> 1), ignoring the glottal stop.
 *   - Southern varieties merge hỏi/ngã and realise nặng differently. This
 *     table is northern.
 *
 * Changing these six rows changes every verdict the tool produces for
 * Vietnamese. One conversation with a fluent speaker should change this one
 * table and nothing else.
 */
const TONES = {
  ngang: { shape: [3, 3], mark: null,     label: "ngang (level)" },
  huyen: { shape: [2, 1], mark: "\u0300", label: "huyền (low falling)" },
  sac:   { shape: [3, 5], mark: "\u0301", label: "sắc (high rising)" },
  hoi:   { shape: [3, 1], mark: "\u0309", label: "hỏi (dipping)" },
  nga:   { shape: [3, 5], mark: "\u0303", label: "ngã (glottalised rising)" },
  nang:  { shape: [2, 1], mark: "\u0323", label: "nặng (glottalised low)" },
};

/** Hyphens and dashes join the syllables of a transliterated name. */
const HYPHEN = /[-\u2010-\u2015]/u;

/** Keep letters and combining marks; drop digits (verse numbers) and punctuation. */
function lettersOnly(token) {
  return token.normalize("NFD").replace(/[^\p{L}\p{M}]/gu, "");
}

/** Punctuation that follows the letters of a token, e.g. "tôi:" -> ":". */
function trailingPunctuation(token) {
  const m = /[^\p{L}\p{M}\d]+$/u.exec(token.normalize("NFC"));
  return m ? m[0] : "";
}

/**
 * Read the tone of one syllable. Returns a tone id, or null when the syllable
 * is malformed (two different tone marks), so nothing is guessed.
 */
function readTone(token) {
  const nfd = token.normalize("NFD");
  const found = new Set();
  for (const ch of nfd) {
    const tone = TONE_MARKS[ch];
    if (tone) found.add(tone);
  }
  if (found.size === 0) return "ngang";
  if (found.size === 1) return found.values().next().value;
  return null;
}

/**
 * Syllables in order. Besides tone and shape, each carries what the chunker
 * needs to break the text where a reader would: `trailing`, the punctuation
 * after the syllable, and `joinedToNext`, true inside a hyphenated name
 * (Giê-hô-va), where a break is never allowed.
 */
function syllabify(text) {
  const out = [];
  for (const token of String(text).split(/\s+/u)) {
    const parts = token.split(HYPHEN);
    const lettered = parts.map((p) => lettersOnly(p));
    for (let i = 0; i < parts.length; i++) {
      const letters = lettered[i];
      if (!letters) continue;
      const tone = readTone(letters);
      const entry = tone ? TONES[tone] : null;
      const joinedToNext = lettered.slice(i + 1).some(Boolean);
      out.push({
        text: letters.normalize("NFC"),
        tone,
        shape: entry ? entry.shape : null,
        unknown: tone === null,
        label: entry ? entry.label : "unknown (malformed)",
        trailing: joinedToNext ? "" : trailingPunctuation(parts[i]),
        joinedToNext,
      });
    }
  }
  return out;
}

/**
 * What a native speaker must confirm about TONES, one entry per tone, in
 * the words the checklist asks. status flips to "verified" here, and the
 * shape above changes, when the answer comes back.
 */
const VALIDATION = {
  status: "unverified",
  region: "Northern (Hanoi) values; ask which region the speaker is from and whether hỏi and ngã sound different to them.",
  tones: {
    ngang: { example: "ma", assumed: "starts mid, stays level", ask: "Does your voice stay level, neither rising nor falling?" },
    huyen: { example: "mà", assumed: "starts low-mid, falls to low", ask: "Does your voice start fairly low and fall further?" },
    sac:   { example: "má", assumed: "starts mid, rises high", ask: "Does your voice start in the middle and rise clearly high?" },
    hoi:   { example: "mả", assumed: "starts mid, ends LOW (the rise back up at the end is ignored)", ask: "Does your voice fall and then come back up, or just fall? In a song, which end matters?" },
    nga:   { example: "mã", assumed: "same pitch path as má (mid to high), glottal break ignored", ask: "Apart from the catch in the throat, does mã end as high as má?" },
    nang:  { example: "mạ", assumed: "same pitch path as mà (low, falling), glottal stop ignored", ask: "Apart from the cut-off, does mạ sit as low as mà?" },
  },
};

module.exports = {
  id: "vi",
  name: "Vietnamese",
  file: "tone/vietnamese.js",
  TONES,
  VALIDATION,
  TONE_MARKS,
  readTone,
  syllabify,
  /** How syllables rejoin into display text: a space between syllables, a hyphen inside names. */
  separator: " ",
};
