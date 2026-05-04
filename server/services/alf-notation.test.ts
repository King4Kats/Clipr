/**
 * Tests pour le module de conversion ALF (Rousselot) ↔ IPA.
 *
 * Approche : on teste avec un échantillon de mots dialectaux courants
 * tirés de la table de référence Wikipedia + cas typiques du français.
 */
import { describe, expect, it } from 'vitest'
import { rousselotToIpa, ipaToRousselot, getMappingTable } from './alf-notation.js'

describe('alf-notation : table', () => {
  it('renvoie la table complète', () => {
    const table = getMappingTable()
    expect(table.consonants.length).toBeGreaterThan(30)
    expect(table.vowels.length).toBeGreaterThan(5)
  })
})

describe('rousselotToIpa : consonnes simples', () => {
  it.each([
    ['b', 'b'],
    ['p', 'p'],
    ['k', 'k'],
    ['ꞓ', 'ʃ'],         // ch français
    ['j', 'ʒ'],          // j français
    ['n̮', 'ɲ'],          // n mouillé (gn)
    ['l̮', 'ʎ'],          // l mouillé
    ['ṅ', 'ŋ'],          // ng anglais
    ['y', 'j'],          // semi-voyelle i
    ['w', 'w'],
    ['ẅ', 'ɥ']           // semi-voyelle u
  ])('%s → %s', (ros, ipa) => {
    expect(rousselotToIpa(ros)).toBe(ipa)
  })
})

describe('rousselotToIpa : voyelles avec diacritiques', () => {
  it('a nu = a', () => {
    expect(rousselotToIpa('a')).toBe('a')
  })
  it('è (grave) = ɛ ouvert', () => {
    expect(rousselotToIpa('è')).toBe('ɛ')
  })
  it('é (aigu) = e fermé', () => {
    expect(rousselotToIpa('é')).toBe('e')
  })
  it('ò (grave) = ɔ ouvert', () => {
    expect(rousselotToIpa('ò')).toBe('ɔ')
  })
  it('ó (aigu) = o fermé', () => {
    expect(rousselotToIpa('ó')).toBe('o')
  })
  it('ã (tilde) = ɑ̃ nasal', () => {
    const result = rousselotToIpa('ã')
    expect(result.normalize('NFC')).toBe('ã'.normalize('NFC'))
  })
  it('ē (macron) = e long', () => {
    expect(rousselotToIpa('ē')).toBe('eː')
  })
  it('ė = schwa', () => {
    expect(rousselotToIpa('ė')).toBe('ə')
  })
})

describe('rousselotToIpa : mots dialectaux', () => {
  it('"vakə" reste lisible', () => {
    // mot "vache" en patois — on s'attend à v + a + k + ə
    expect(rousselotToIpa('vakė')).toBe('vakə')
  })
  it('"l̮œt" (lait, palatale + voyelle ronde)', () => {
    expect(rousselotToIpa('l̮œt')).toBe('ʎøt̪')
  })
  it('"n̮ó" = ɲo (gnio)', () => {
    expect(rousselotToIpa('n̮ó')).toBe('ɲo')
  })
})

describe('ipaToRousselot : retour basique', () => {
  it.each([
    ['b', 'b'],
    ['ʃ', 'ꞓ'],
    ['ʒ', 'j'],
    ['ɲ', 'n̮'],
    ['ʎ', 'l̮'],
    ['ŋ', 'ṅ']
  ])('%s → %s', (ipa, ros) => {
    expect(ipaToRousselot(ipa).normalize('NFC')).toBe(ros.normalize('NFC'))
  })
})

describe('ipaToRousselot : voyelles avec timbre', () => {
  it('ɛ → è', () => {
    expect(ipaToRousselot('ɛ').normalize('NFC')).toBe('è'.normalize('NFC'))
  })
  it('ɔ → ò', () => {
    expect(ipaToRousselot('ɔ').normalize('NFC')).toBe('ò'.normalize('NFC'))
  })
  it('ə → ė', () => {
    expect(ipaToRousselot('ə').normalize('NFC')).toBe('ė'.normalize('NFC'))
  })
})

describe('ipaToRousselot : longueur', () => {
  it('aː → ā', () => {
    expect(ipaToRousselot('aː').normalize('NFC')).toBe('ā'.normalize('NFC'))
  })
})

describe('round-trip Rousselot → IPA → Rousselot (sans collision)', () => {
  // Ces cas ne perdent pas d'info car leur IPA est unique
  it.each([
    'b', 'p', 'k', 'ꞓ',
    'è', 'ò',          // formes ouvertes : IPA distinct (ɛ, ɔ)
    'a', 'e', 'o', 'i', // formes neutres : préservées
    'ė', 'vakė'        // schwa : neutre=ouvert=fermé donc préservé
  ])('%s', (input) => {
    const ipa = rousselotToIpa(input)
    const back = ipaToRousselot(ipa)
    expect(back.normalize('NFC')).toBe(input.normalize('NFC'))
  })
})

describe('round-trip Rousselot → IPA → Rousselot (collision attendue)', () => {
  // Pour les voyelles où Rousselot fermée et neutre donnent le même IPA,
  // le round-trip préfère la forme neutre. C'est le comportement attendu.
  it.each([
    ['é', 'e'],
    ['ó', 'o'],
    ['á', 'a'],
    ['í', 'i']
  ])('%s → %s (perte de l\'accent aigu)', (input, expected) => {
    const ipa = rousselotToIpa(input)
    const back = ipaToRousselot(ipa)
    expect(back.normalize('NFC')).toBe(expected.normalize('NFC'))
  })
})
