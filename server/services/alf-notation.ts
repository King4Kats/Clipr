/**
 * =============================================================================
 * Fichier : alf-notation.ts
 * Rôle    : Conversion entre l'alphabet phonétique de l'ALF (Rousselot-Gilliéron)
 *           et l'API (Alphabet Phonétique International / IPA).
 *
 *           L'ALF de Gilliéron (1902-1910) utilise une notation phonétique
 *           définie par l'abbé Rousselot dans la Revue des patois gallo-romans
 *           (1887). Cette notation est antérieure à la standardisation de l'API
 *           et n'est PAS de l'IPA — c'est un système Latin-based avec
 *           diacritiques, conçu pour les langues gallo-romanes.
 *
 *           Sources de la table :
 *           - Wikipedia FR « Alphabet Rousselot-Gilliéron »
 *           - Notice de l'ALF (Gilliéron 1902)
 *           - Système SYMILA Toulouse (transposition validée)
 *
 *           ATTENTION : la transposition n'est jamais 100% univoque.
 *           Pour des études strictement phonétiques, toujours se référer
 *           à la transcription Rousselot originale.
 *
 *           Approche : décomposition base + modificateurs.
 *           - Une voyelle Rousselot = base + accents (ouverture/fermeture/longueur/nasalité)
 *           - On lit caractère par caractère et on assemble la chaîne IPA équivalente
 * =============================================================================
 */

// ── Table consonnes (1 ↔ 1) ──
// Chaque entrée : { rousselot, ipa, description }
// Liste tirée du tableau Wikipedia (col Symboles | Notes | API)
const CONSONANTS: { r: string; ipa: string; note?: string }[] = [
  { r: 'b', ipa: 'b' },
  { r: 'ꞓ', ipa: 'ʃ', note: 'ch français' },
  { r: 'c̑', ipa: 'ç', note: 'Ich-Laut' },
  { r: 'ç̑', ipa: 'χ', note: 'Ach-Laut' },
  { r: 'd', ipa: 'd̪' },
  { r: 'ḓ', ipa: 'd', note: 'd anglais' },
  { r: 'f', ipa: 'f' },
  { r: 'ɡ', ipa: 'ɡ', note: 'g dur' },
  { r: 'g', ipa: 'ɡ', note: 'variante typographique de ɡ' },
  { r: 'h', ipa: 'h', note: 'h aspiré' },
  { r: 'j', ipa: 'ʒ' },
  { r: 'k', ipa: 'k' },
  { r: 'l', ipa: 'l' },
  { r: 'l̮', ipa: 'ʎ', note: 'l palatale (mouillée)' },
  { r: 'l̮̣', ipa: 'ɭ', note: 'l résonnante' },
  { r: 'm', ipa: 'm' },
  { r: 'ṃ', ipa: 'm̥', note: 'm sourde / résonnante' },
  { r: 'n', ipa: 'n' },
  { r: 'n̮', ipa: 'ɲ', note: 'n palatale (mouillée)' },
  { r: 'ṅ', ipa: 'ŋ', note: 'n vélaire' },
  { r: 'p', ipa: 'p' },
  { r: 'r', ipa: 'r', note: 'r roulée longuement' },
  { r: 'r̃', ipa: 'ʀ', note: 'r grasseyée' },
  { r: 'ȓ', ipa: 'ʁ', note: 'r française/allemande' },
  { r: 'ṙ', ipa: 'ɣ', note: 'r vélaire / spirante' },
  { r: 'ṛ', ipa: 'ɾ', note: 'r roulée brève' },
  { r: 'r̥', ipa: 'r̥', note: 'r résonnante sourde' },
  { r: 's', ipa: 's', note: 's sourde' },
  { r: 'ṣ', ipa: 'θ', note: 'th dur anglais' },
  { r: 't', ipa: 't̪' },
  { r: 't̯', ipa: 't', note: 't anglais' },
  { r: 'v', ipa: 'v' },
  { r: 'w', ipa: 'w' },
  { r: 'ẅ', ipa: 'ɥ', note: 'u semi-consonne' },
  { r: 'y', ipa: 'j', note: 'i semi-consonne' },
  { r: 'z', ipa: 'z' },
  { r: 'ẓ', ipa: 'ð', note: 'th doux anglais' }
]

// ── Table voyelles : bases ──
// Convention Rousselot : la voyelle nue est neutre (ni ouverte ni fermée).
// Les diacritiques (grave, aigu, macron, brève, tilde) modulent timbre/longueur/nasalité.
const VOWEL_BASES: { r: string; ipa_neutral: string; ipa_open: string; ipa_close: string }[] = [
  // Format : base sans accent, IPA neutre (par défaut), IPA ouverte (à á), IPA fermée (è/é)
  { r: 'a', ipa_neutral: 'a', ipa_open: 'ɑ', ipa_close: 'a' },
  { r: 'e', ipa_neutral: 'e', ipa_open: 'ɛ', ipa_close: 'e' },
  { r: 'ė', ipa_neutral: 'ə', ipa_open: 'ə', ipa_close: 'ə' }, // schwa
  { r: 'i', ipa_neutral: 'i', ipa_open: 'ɪ', ipa_close: 'i' },
  { r: 'o', ipa_neutral: 'o', ipa_open: 'ɔ', ipa_close: 'o' },
  { r: 'u', ipa_neutral: 'y', ipa_open: 'œ', ipa_close: 'y' }, // u Rousselot = u français = /y/
  { r: 'ꭒ', ipa_neutral: 'u', ipa_open: 'ʊ', ipa_close: 'u' }, // ɯ-like = u "ou" français /u/
  { r: 'œ', ipa_neutral: 'ø', ipa_open: 'œ', ipa_close: 'ø' }
]

// ── Diacritiques combinables (Unicode combining marks) ──
const DIACRITIC = {
  GRAVE: '̀',     // à è ò → voyelle ouverte
  ACUTE: '́',     // á é ó → voyelle fermée
  MACRON: '̄',    // ā ē ō → voyelle longue
  BREVE: '̆',     // ă ĕ ŏ → voyelle brève
  TILDE: '̃',     // ã ẽ õ → voyelle nasale
  DOT_BELOW: '̣', // ṛ ṣ ẓ → consonnes spéciales
  DOT_ABOVE: '̇', // ṅ ṙ → consonnes vélaires
  CARON: '̌',     // č ž etc
  CIRCUMFLEX: '̂' // â ê ô
}

const IPA_LONG = 'ː'
const IPA_NASAL = '̃'

// ── Index inversés (construits une fois) ──
const consonantByR = new Map<string, string>()
const consonantByIpa = new Map<string, string>()
for (const c of CONSONANTS) {
  if (!consonantByR.has(c.r)) consonantByR.set(c.r, c.ipa)
  if (!consonantByIpa.has(c.ipa)) consonantByIpa.set(c.ipa, c.r)
}

const vowelByR = new Map<string, { neutral: string; open: string; close: string }>()
for (const v of VOWEL_BASES) {
  vowelByR.set(v.r, { neutral: v.ipa_neutral, open: v.ipa_open, close: v.ipa_close })
}

/**
 * Décompose un texte normalisé NFD en tokens : pour chaque caractère de base,
 * on accumule les diacritiques combinants qui le suivent.
 * Renvoie un tableau de { base, marks: [...] }.
 */
function tokenize(input: string): { base: string; marks: string[] }[] {
  const nfd = input.normalize('NFD')
  const tokens: { base: string; marks: string[] }[] = []
  for (const ch of nfd) {
    const code = ch.codePointAt(0) || 0
    const isCombining =
      (code >= 0x0300 && code <= 0x036f) || // diacritiques de base
      (code >= 0x1ab0 && code <= 0x1aff) || // diacritiques étendus
      (code >= 0x1dc0 && code <= 0x1dff) || // diacritiques supplémentaires
      (code >= 0x20d0 && code <= 0x20ff) || // marques de symboles
      (code >= 0xfe20 && code <= 0xfe2f)    // demi-marques
    if (isCombining && tokens.length > 0) {
      tokens[tokens.length - 1].marks.push(ch)
    } else {
      tokens.push({ base: ch, marks: [] })
    }
  }
  return tokens
}

/**
 * Convertit une chaîne de notation Rousselot (ALF) vers IPA.
 * Approche caractère par caractère :
 *  1. On tokenise (base + diacritiques combinés)
 *  2. Pour chaque token, on regarde si c'est une voyelle ou consonne
 *  3. On applique les modifications (timbre, longueur, nasalité)
 */
export function rousselotToIpa(rousselot: string): string {
  const tokens = tokenize(rousselot)
  const out: string[] = []

  for (const tok of tokens) {
    // Tentative consonne : on essaie d'abord la forme complète (avec diacritiques)
    const fullForm = (tok.base + tok.marks.join('')).normalize('NFC')
    const conso = consonantByR.get(fullForm)
    if (conso) {
      out.push(conso)
      continue
    }

    // Tentative voyelle : on essaie d'abord la forme complète (cas ė = e+dot)
    // car certaines bases voyelles incluent un diacritique non-modulant.
    const vowelFull = vowelByR.get(fullForm)
    if (vowelFull) {
      out.push(vowelFull.neutral)
      continue
    }
    const vowel = vowelByR.get(tok.base)
    if (vowel) {
      const hasGrave = tok.marks.includes(DIACRITIC.GRAVE)
      const hasAcute = tok.marks.includes(DIACRITIC.ACUTE)
      const hasMacron = tok.marks.includes(DIACRITIC.MACRON)
      const hasTilde = tok.marks.includes(DIACRITIC.TILDE)

      let ipaVowel = vowel.neutral
      if (hasGrave) ipaVowel = vowel.open
      else if (hasAcute) ipaVowel = vowel.close

      // Nasalité
      if (hasTilde) ipaVowel = ipaVowel + IPA_NASAL

      // Longueur
      if (hasMacron) ipaVowel = ipaVowel + IPA_LONG

      out.push(ipaVowel)
      continue
    }

    // Caractère inconnu : on laisse tel quel (espaces, ponctuation, ou symbole rare)
    out.push(fullForm)
  }

  return out.join('')
}

/**
 * Convertit une chaîne IPA vers la notation Rousselot (ALF).
 * Approche : décomposition NFD, mapping consonne directe, voyelle + diacritiques.
 *
 * Limitations : certaines distinctions IPA (ex: tons, allophones précis)
 * n'ont pas d'équivalent Rousselot direct, on retombe sur le symbole le plus proche.
 */
export function ipaToRousselot(ipa: string): string {
  const tokens = tokenize(ipa)
  const out: string[] = []

  for (const tok of tokens) {
    // Cas spécial : ː (longueur) attaché au token précédent
    if (tok.base === IPA_LONG) {
      // On ajoute un macron à la voyelle précédente si possible
      if (out.length > 0) {
        out[out.length - 1] = (out[out.length - 1] + DIACRITIC.MACRON).normalize('NFC')
      }
      continue
    }

    // Consonnes : essai forme complète d'abord
    const fullForm = (tok.base + tok.marks.join('')).normalize('NFC')
    const conso = consonantByIpa.get(fullForm)
    if (conso) {
      out.push(conso)
      continue
    }
    const consoBase = consonantByIpa.get(tok.base)
    if (consoBase) {
      out.push(consoBase)
      continue
    }

    // Voyelles : on cherche dans VOWEL_BASES quelle base correspond
    // Règle de désambiguïsation :
    //  - Si l'IPA == ipa_open (et différent de close) → forme ouverte (accent grave)
    //  - Si l'IPA == ipa_close MAIS aussi == ipa_neutral → forme neutre (sans accent),
    //    car en pratique l'ALF utilise la forme nue par défaut.
    //  - Si l'IPA == ipa_close ET différent de ipa_neutral → forme fermée (accent aigu)
    let matched = false
    for (const v of VOWEL_BASES) {
      const isOpen = tok.base === v.ipa_open
      const isClose = tok.base === v.ipa_close
      const isNeutral = tok.base === v.ipa_neutral

      if (!isOpen && !isClose && !isNeutral) continue

      let r = v.r
      if (isOpen && v.ipa_open !== v.ipa_neutral) {
        r = (v.r + DIACRITIC.GRAVE).normalize('NFC')
      } else if (isClose && !isNeutral && v.ipa_close !== v.ipa_neutral) {
        r = (v.r + DIACRITIC.ACUTE).normalize('NFC')
      }
      // Sinon : forme neutre (sans accent) — c'est le comportement par défaut

      // Nasalité
      if (tok.marks.includes(IPA_NASAL)) {
        r = (r + DIACRITIC.TILDE).normalize('NFC')
      }

      out.push(r)
      matched = true
      break
    }
    if (matched) continue

    // Fallback : caractère IPA non reconnu, on le garde tel quel
    out.push(fullForm)
  }

  return out.join('')
}

/**
 * Renvoie la table complète des correspondances pour debug / UI.
 */
export function getMappingTable(): { consonants: typeof CONSONANTS; vowels: typeof VOWEL_BASES } {
  return { consonants: CONSONANTS, vowels: VOWEL_BASES }
}
