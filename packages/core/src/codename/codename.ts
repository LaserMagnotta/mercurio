// Shipment codenames — a human-sayable handle for a shipment.
//
// The UUID and the QR token remain the real identifiers: the codename is a
// LABEL, never a credential. It is deliberately short and guessable, so no
// route may ever authorize on it (ARCHITECTURE.md §7: even the QR, which is
// printed on the parcel, authorizes nothing on its own — a codename, which
// travels in email subjects and gets read out at a counter, is weaker still).
//
// Italian, because the UI is Italian (CLAUDE.md).

import { CODENAME_PATTERN } from '@mercurio/shared';

export { CODENAME_PATTERN };

/** Grammatical gender of the animal. Italian adjectives agree with the noun,
 *  so animal and adjective cannot be drawn as independent words: "Volpe
 *  Ambrato" is simply wrong Italian, and a codename people read aloud is
 *  exactly where broken agreement gets noticed. */
export type CodenameGender = 'm' | 'f';

export interface CodenameAnimal {
  readonly word: string;
  readonly gender: CodenameGender;
}

/** [masculine, feminine], spelled out rather than derived from an -o/-a rule:
 *  a whole class of Italian adjectives does not inflect at all (those ending
 *  in -e, e.g. "Veloce"), so a rule would quietly emit wrong Italian for a
 *  third of the list. The table is longer, but every entry is reviewable. */
export type CodenameAdjective = readonly [masculine: string, feminine: string];

// Curation (CLAUDE.md asks for "liste di parole curate: niente termini
// ambigui"). Three exclusion rules were applied to both lists, and they are
// the reason many obvious Italian animals are missing here:
//
//  1. No word that doubles as an insult or vulgar slang — "passera", "trota",
//     "foca", "balena", "civetta", "lucciola", "vipera", "asino", "maiale".
//  2. No word that reads as a bad omen for a parcel in someone else's
//     custody. "Gazza" (gazza ladra — the thieving magpie), "anguilla"
//     (slippery, evasive), "gambero" and "granchio" (Italian idioms for going
//     backwards and for blundering) would all be unfortunate names for a
//     shipment whose whole protocol is about custody and progress.
//  3. Nothing confusable with a money field or with the declared content.
//     "Tasso" survives despite "tasso di cambio" because the codename always
//     appears as a three-part hyphenated token ("Tasso-Ambrato-742"), which
//     no exchange rate ever looks like.

export const CODENAME_ANIMALS: readonly CodenameAnimal[] = [
  { word: 'Tasso', gender: 'm' },
  { word: 'Falco', gender: 'm' },
  { word: 'Riccio', gender: 'm' },
  { word: 'Cervo', gender: 'm' },
  { word: 'Lupo', gender: 'm' },
  { word: 'Delfino', gender: 'm' },
  { word: 'Airone', gender: 'm' },
  { word: 'Camoscio', gender: 'm' },
  { word: 'Stambecco', gender: 'm' },
  { word: 'Ghiro', gender: 'm' },
  { word: 'Picchio', gender: 'm' },
  { word: 'Cardellino', gender: 'm' },
  { word: 'Pettirosso', gender: 'm' },
  { word: 'Usignolo', gender: 'm' },
  { word: 'Gabbiano', gender: 'm' },
  { word: 'Capriolo', gender: 'm' },
  { word: 'Castoro', gender: 'm' },
  { word: 'Scoiattolo', gender: 'm' },
  { word: 'Fenicottero', gender: 'm' },
  { word: 'Ermellino', gender: 'm' },
  { word: 'Volpe', gender: 'f' },
  { word: 'Lontra', gender: 'f' },
  { word: 'Martora', gender: 'f' },
  { word: 'Donnola', gender: 'f' },
  { word: 'Lepre', gender: 'f' },
  { word: 'Aquila', gender: 'f' },
  { word: 'Poiana', gender: 'f' },
  { word: 'Allodola', gender: 'f' },
  { word: 'Rondine', gender: 'f' },
  { word: 'Cicogna', gender: 'f' },
  { word: 'Libellula', gender: 'f' },
  { word: 'Farfalla', gender: 'f' },
  { word: 'Lince', gender: 'f' },
  { word: 'Gazzella', gender: 'f' },
  { word: 'Cinciallegra', gender: 'f' },
  { word: 'Ghiandaia', gender: 'f' },
  { word: 'Upupa', gender: 'f' },
  { word: 'Salamandra', gender: 'f' },
  { word: 'Coccinella', gender: 'f' },
  { word: 'Tortora', gender: 'f' },
] as const;

export const CODENAME_ADJECTIVES: readonly CodenameAdjective[] = [
  ['Ambrato', 'Ambrata'],
  ['Argenteo', 'Argentea'],
  ['Dorato', 'Dorata'],
  ['Bruno', 'Bruna'],
  ['Candido', 'Candida'],
  ['Fulvo', 'Fulva'],
  ['Purpureo', 'Purpurea'],
  ['Vermiglio', 'Vermiglia'],
  ['Boreale', 'Boreale'],
  ['Celeste', 'Celeste'],
  ['Turchese', 'Turchese'],
  ['Lucente', 'Lucente'],
  ['Radioso', 'Radiosa'],
  ['Brillante', 'Brillante'],
  ['Limpido', 'Limpida'],
  ['Sereno', 'Serena'],
  ['Tranquillo', 'Tranquilla'],
  ['Placido', 'Placida'],
  ['Allegro', 'Allegra'],
  ['Vivace', 'Vivace'],
  ['Veloce', 'Veloce'],
  ['Rapido', 'Rapida'],
  ['Svelto', 'Svelta'],
  ['Agile', 'Agile'],
  ['Ardito', 'Ardita'],
  ['Tenace', 'Tenace'],
  ['Robusto', 'Robusta'],
  ['Fiero', 'Fiera'],
  ['Attento', 'Attenta'],
  ['Vigile', 'Vigile'],
  ['Preciso', 'Precisa'],
  ['Puntuale', 'Puntuale'],
  ['Paziente', 'Paziente'],
  ['Gentile', 'Gentile'],
  ['Cortese', 'Cortese'],
  ['Onesto', 'Onesta'],
  ['Fedele', 'Fedele'],
  ['Sicuro', 'Sicura'],
  ['Elegante', 'Elegante'],
  ['Curioso', 'Curiosa'],
] as const;

/** Serial range. Three digits with no leading zero: always the same width, so
 *  codenames line up in a list, and no "007" that someone might retype as "7". */
export const CODENAME_MIN_SERIAL = 100;
export const CODENAME_MAX_SERIAL = 999;

const SERIAL_SPAN = CODENAME_MAX_SERIAL - CODENAME_MIN_SERIAL + 1;

/** Size of the name space. The minting loop in apps/api probes for a free
 *  codename before inserting; at MVP volumes against ~1.4M combinations the
 *  probe practically never has to retry, and the unique index is the backstop
 *  for the race the probe cannot close. */
export const CODENAME_COMBINATIONS =
  CODENAME_ANIMALS.length * CODENAME_ADJECTIVES.length * SERIAL_SPAN;

/**
 * Mint one codename, e.g. "Tasso-Ambrato-742".
 *
 * `random` is injectable so the tests can drive it deterministically. The
 * default is Math.random and that is deliberate: a codename is a label, not a
 * secret — nothing is authorized by knowing one, so it has no need of a CSPRNG
 * (unlike `generateToken` in apps/api, which mints real bearer credentials).
 */
export function generateCodename(random: () => number = Math.random): string {
  const animal = CODENAME_ANIMALS[Math.floor(random() * CODENAME_ANIMALS.length)]!;
  const adjective = CODENAME_ADJECTIVES[Math.floor(random() * CODENAME_ADJECTIVES.length)]!;
  const serial = CODENAME_MIN_SERIAL + Math.floor(random() * SERIAL_SPAN);
  return `${animal.word}-${animal.gender === 'm' ? adjective[0] : adjective[1]}-${serial}`;
}
