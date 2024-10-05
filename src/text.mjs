/**
 * Decoding, ordering, sanitising, and the shapes a declared name may take.
 *
 * Every value this module handles arrived in a file this tool did not write, so
 * every value it returns is treated as data on its way to a report and never as
 * something allowed to decide a line of that report. Nothing here reads the
 * filesystem, the network, a locale or a clock.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `String.prototype.localeCompare` and `Intl.Collator` both consult ICU data
 * that differs between Node builds, and both weigh punctuation differently from
 * its code point. Tool ids, role ids and scope patterns in this package carry
 * upper case and `.`, `-`, `_`, `:`, `/` and `*`, so a collated report would
 * list a different tool first and name a different scope in a breadth finding
 * on a different machine. Every order this package emits is decided here.
 *
 * Neither spelling of the locale-aware comparison appears anywhere in this
 * package, and `test/ordering.test.mjs` pins what the tool *emits* rather than
 * what its source says -- a source scan cannot tell one comparator from the
 * other, so a source scan is not the test.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output.
 *
 * Built from code points rather than written out: a literal U+2028 or U+2029 in
 * a module is a line terminator to the JavaScript parser, and every other
 * member of the set is invisible in an editor. Spelling them keeps this file
 * plain ASCII and keeps the list reviewable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in the
 *   human summary, ESC opens a terminal escape sequence, NUL truncates a value
 *   in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two members
 *   need no help at all: U+0085 NEL is a line break to a great many consumers
 *   and U+009B is the 8-bit CSI, a control introducer with no ESC in front.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a tool id reading `repo.read` can be displayed while the map
 *   compares something else -- and a reviewer deciding whether a scope is too
 *   broad would be reading a name the report is not about.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- tool ids, role
 * ids, scopes, data-class ids, file names, pointers, messages, suggestions and
 * evidence alike, not only an excerpt field. Tab, newline and carriage return
 * are left out of this class because `excerpt` collapses them to a single space
 * one step later, which reaches the same place by a shorter route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What a value may not contain if it is to be used as a name: the same classes
 * plus the three ASCII whitespace controls `CONTROL` leaves to the collapse. A
 * name gets no second pass -- an id whose printed form differs from the id the
 * map compared is an id nobody can audit, so it is refused at the door.
 */
const FORBIDDEN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * True when any forbidden character appears anywhere in the value. Exported so
 * a test can walk an entire serialised report and assert that none survived
 * anywhere, rather than checking the one field somebody remembered.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN.test(String(value))
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 120
export const MAX_SCOPE_LENGTH = 200
export const MAX_DESCRIPTION_LENGTH = 300

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every id, scope, file name, pointer, message and piece of evidence that
 * reaches a finding passes through here. A tool in this catalog sanitised its
 * evidence carefully and left its identifiers raw, so a record id holding a
 * newline printed two lines into the human report and invented a finding that
 * was never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * The name alphabet: tool ids, role ids, data-class ids and the policy version.
 *
 * Wide enough for the spellings real declarations use -- `github.issues.write`,
 * `support-agent`, `pii/contact`, `2026-09-1` -- which means upper case, `.`,
 * `:`, `/`, `+`, `-` and `_` all occur, which is in turn why order here is
 * decided by code unit. One character class under one quantifier, so it is
 * linear in its input, and the input is length-bounded before it runs. No
 * pattern in this package is ever compiled out of input: a declaration being
 * mapped cannot choose what gets matched.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/

export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (FORBIDDEN.test(value)) return false
  return IDENTIFIER.test(value)
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field is arbitrary content from a file this tool did not write,
 * and the report goes to stdout -- a stream that gets piped, logged and pasted
 * somewhere more public than the input ever was. Echoing the value hands that
 * content a wider audience than it had, on exactly the fields whose validation
 * exists to keep something unexpected out of the report. The pointer on the
 * finding names the exact position, which is what a reader needs.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains a
 * replacement character, and that confusion has already let an unread input
 * report a pass in this catalog. The decoder decides; the decoded text never
 * gets a vote. Every file this tool opens goes through here, with no exception
 * for the one a reviewer thinks of as configuration.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
