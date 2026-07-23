/**
 * Deterministic Korean 2-set keyboard correction.
 *
 * Search uses this only as a zero-result fallback, so legitimate English and
 * Korean queries always keep their original meaning and database ranking.
 */
const INITIALS = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const;
const VOWELS = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
  "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
] as const;
const FINALS = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ",
  "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const;

const KEY_TO_JAMO: Record<string, string> = {
  r: "ㄱ", R: "ㄲ", s: "ㄴ", e: "ㄷ", E: "ㄸ", f: "ㄹ",
  a: "ㅁ", q: "ㅂ", Q: "ㅃ", t: "ㅅ", T: "ㅆ", d: "ㅇ",
  w: "ㅈ", W: "ㅉ", c: "ㅊ", z: "ㅋ", x: "ㅌ", v: "ㅍ", g: "ㅎ",
  k: "ㅏ", o: "ㅐ", i: "ㅑ", O: "ㅒ", j: "ㅓ", p: "ㅔ",
  u: "ㅕ", P: "ㅖ", h: "ㅗ", y: "ㅛ", n: "ㅜ", b: "ㅠ",
  m: "ㅡ", l: "ㅣ",
};

const COMPOUND_VOWELS: Record<string, string> = {
  "ㅗㅏ": "ㅘ", "ㅗㅐ": "ㅙ", "ㅗㅣ": "ㅚ",
  "ㅜㅓ": "ㅝ", "ㅜㅔ": "ㅞ", "ㅜㅣ": "ㅟ", "ㅡㅣ": "ㅢ",
};
const COMPOUND_FINALS: Record<string, string> = {
  "ㄱㅅ": "ㄳ", "ㄴㅈ": "ㄵ", "ㄴㅎ": "ㄶ", "ㄹㄱ": "ㄺ",
  "ㄹㅁ": "ㄻ", "ㄹㅂ": "ㄼ", "ㄹㅅ": "ㄽ", "ㄹㅌ": "ㄾ",
  "ㄹㅍ": "ㄿ", "ㄹㅎ": "ㅀ", "ㅂㅅ": "ㅄ",
};
const SPLIT_FINALS = Object.fromEntries(
  Object.entries(COMPOUND_FINALS).map(([pair, combined]) => [
    combined,
    Array.from(pair),
  ]),
) as Record<string, string[]>;

const JAMO_TO_KEY: Record<string, string> = {
  ㄱ: "r", ㄲ: "R", ㄴ: "s", ㄷ: "e", ㄸ: "E", ㄹ: "f",
  ㅁ: "a", ㅂ: "q", ㅃ: "Q", ㅅ: "t", ㅆ: "T", ㅇ: "d",
  ㅈ: "w", ㅉ: "W", ㅊ: "c", ㅋ: "z", ㅌ: "x", ㅍ: "v", ㅎ: "g",
  ㅏ: "k", ㅐ: "o", ㅑ: "i", ㅒ: "O", ㅓ: "j", ㅔ: "p",
  ㅕ: "u", ㅖ: "P", ㅗ: "h", ㅘ: "hk", ㅙ: "ho", ㅚ: "hl",
  ㅛ: "y", ㅜ: "n", ㅝ: "nj", ㅞ: "np", ㅟ: "nl", ㅠ: "b",
  ㅡ: "m", ㅢ: "ml", ㅣ: "l",
  ㄳ: "rt", ㄵ: "sw", ㄶ: "sg", ㄺ: "fr", ㄻ: "fa", ㄼ: "fq",
  ㄽ: "ft", ㄾ: "fx", ㄿ: "fv", ㅀ: "fg", ㅄ: "qt",
};

const initialIndex = new Map<string, number>(
  INITIALS.map((value, index) => [value, index]),
);
const vowelIndex = new Map<string, number>(
  VOWELS.map((value, index) => [value, index]),
);
const finalIndex = new Map<string, number>(
  FINALS.map((value, index) => [value, index]),
);

function composeSyllable(initial: string, vowel: string, final = "") {
  const initialPosition = initialIndex.get(initial);
  const vowelPosition = vowelIndex.get(vowel);
  const finalPosition = finalIndex.get(final) ?? 0;
  if (initialPosition === undefined || vowelPosition === undefined)
    return `${initial}${vowel}${final}`;
  return String.fromCharCode(
    0xac00 + (initialPosition * 21 + vowelPosition) * 28 + finalPosition,
  );
}

export function englishKeysToHangul(value: string): string {
  let output = "";
  let initial = "";
  let vowel = "";
  let final = "";

  const flush = () => {
    if (initial && vowel) output += composeSyllable(initial, vowel, final);
    else output += `${initial}${vowel}${final}`;
    initial = "";
    vowel = "";
    final = "";
  };

  for (const input of Array.from(value)) {
    const jamo = KEY_TO_JAMO[input];
    if (!jamo) {
      flush();
      output += input;
      continue;
    }
    if (vowelIndex.has(jamo)) {
      if (!initial) {
        flush();
        output += jamo;
        continue;
      }
      if (!vowel) {
        vowel = jamo;
        continue;
      }
      if (!final) {
        const compound = COMPOUND_VOWELS[`${vowel}${jamo}`];
        if (compound) {
          vowel = compound;
          continue;
        }
        flush();
        output += jamo;
        continue;
      }
      const split = SPLIT_FINALS[final];
      const nextInitial = split?.[1] ?? final;
      final = split?.[0] ?? "";
      flush();
      initial = nextInitial;
      vowel = jamo;
      continue;
    }

    if (!initial) {
      initial = jamo;
      continue;
    }
    if (!vowel) {
      flush();
      initial = jamo;
      continue;
    }
    if (!final && finalIndex.has(jamo)) {
      final = jamo;
      continue;
    }
    if (final) {
      const compound = COMPOUND_FINALS[`${final}${jamo}`];
      if (compound) {
        final = compound;
        continue;
      }
    }
    flush();
    initial = jamo;
  }
  flush();
  return output;
}

export function hangulToEnglishKeys(value: string): string {
  return Array.from(value, (character) => {
    const codepoint = character.charCodeAt(0);
    if (codepoint >= 0xac00 && codepoint <= 0xd7a3) {
      const offset = codepoint - 0xac00;
      const initial = INITIALS[Math.floor(offset / 588)];
      const vowel = VOWELS[Math.floor((offset % 588) / 28)];
      const final = FINALS[offset % 28];
      return `${JAMO_TO_KEY[initial]}${JAMO_TO_KEY[vowel]}${JAMO_TO_KEY[final] ?? ""}`;
    }
    return JAMO_TO_KEY[character] ?? character;
  }).join("");
}

/**
 * Returns conservative fallbacks only. English-to-Korean candidates must
 * compose entirely into complete Hangul syllables so ordinary English names
 * such as `Sofia` are not silently reinterpreted.
 */
export function keyboardSearchAlternates(value: unknown): string[] {
  const input = String(value ?? "").trim();
  if (input.length < 2 || input.length > 120) return [];
  const alternates: string[] = [];
  if (/^[A-Za-z\s]+$/u.test(input)) {
    const converted = englishKeysToHangul(input);
    const compact = converted.replace(/\s/gu, "");
    if (
      compact.length >= 2 &&
      /^[가-힣]+$/u.test(compact) &&
      converted !== input
    ) {
      alternates.push(converted);
    }
  }
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(input)) {
    const converted = hangulToEnglishKeys(input);
    if (/^[A-Za-z\s]+$/u.test(converted) && converted !== input)
      alternates.push(converted);
  }
  return [...new Set(alternates)];
}
