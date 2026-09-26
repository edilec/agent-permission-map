/**
 * The three ladders this build implements, and how the breadth of a declared
 * scope is measured.
 *
 * Every vocabulary here is closed. A word outside a ladder is refused and
 * recorded as an assumption this run could not make -- it is never mapped onto
 * the nearest word that looks similar, because for a permission map the
 * convenient guess is always the permissive one. `execute` guessed as `read`,
 * or `restricted` guessed as `internal`, turns a refusal into a green build.
 */

import { MAX_SCOPE_LENGTH, hasForbiddenCharacter } from './text.mjs'

/**
 * What a tool does to a resource, weakest first.
 *
 * The order is a declared convention of this build rather than a fact about the
 * world, so it is written down here and in `docs/permission-rules.md` and used
 * from one place: `read` observes, `write` changes what is there, `execute`
 * runs a declared action with effects outside the store, `delete` destroys, and
 * `admin` changes who may do any of the four. A role's ceiling is compared
 * against this order, so moving a word changes verdicts and is a breaking
 * change to the rule catalog.
 */
export const CAPABILITIES = Object.freeze(['read', 'write', 'execute', 'delete', 'admin'])

/** How sensitive a data class is, least first. */
export const SENSITIVITIES = Object.freeze(['public', 'internal', 'confidential', 'restricted'])

/**
 * How much human approval an action carries, weakest first.
 *
 * `none` is unattended, `per-session` is approved once for a working session,
 * `per-action` is approved each time, and `two-person` needs a second
 * authoriser. A declared approval weaker than the requirement for its
 * capability and sensitivity is the central refusal of this tool.
 */
export const APPROVALS = Object.freeze(['none', 'per-session', 'per-action', 'two-person'])

/** What a requirement says about a scope that reaches an unbounded number of resources. */
export const UNBOUNDED_SCOPE_POSITIONS = Object.freeze(['allowed', 'forbidden'])

/** The position of a word on a ladder, or -1 when the word is not on it. */
export function rankOf(ladder, word) {
  if (typeof word !== 'string') return -1
  return ladder.indexOf(word)
}

/** The characters a scope pattern may be built from. */
const SCOPE_CHARACTERS = /^[A-Za-z0-9._:/+*@-]+$/

/** The marker for "any number of further segments", which is what makes a scope unbounded. */
export const UNBOUNDED_SEGMENT = '**'

/**
 * An optional `scheme://` prefix, recognised so that the two spellings real
 * exports use -- `docs:public/**` and `docs://public/**` -- measure the same.
 *
 * The prefix is not a path segment and is not counted as one. Without this, the
 * doubled slash of a URL-shaped scope reads as an empty segment and the scope
 * is refused: correct for `a//b`, and a false refusal for every scope anybody
 * actually writes.
 */
const REALM_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

/**
 * Measure a declared scope pattern.
 *
 * The pattern is split on `/` into segments. A segment of `**` reaches an
 * unbounded number of resources; any other segment containing `*` reaches an
 * unknown number of resources at one level. Both numbers are reported, and
 * neither is judged here: what counts as too broad is a property of the policy
 * requirement that governs the tool, not of this function, which is why a
 * policy can permit a wide read and refuse a wide delete.
 *
 * Nothing in this package ever expands a pattern against a resource list. This
 * tool has no resource list -- it reads declarations, and a declaration is all
 * it reports on.
 *
 * @returns {{ok: true, scope: object}|{ok: false, reason: string, detail?: unknown}}
 */
export function compileScope(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'shape' }
  if (raw.length === 0) return { ok: false, reason: 'empty' }
  if (raw.length > MAX_SCOPE_LENGTH) return { ok: false, reason: 'too-long', detail: raw.length }
  if (hasForbiddenCharacter(raw)) return { ok: false, reason: 'forbidden-character' }
  if (!SCOPE_CHARACTERS.test(raw)) return { ok: false, reason: 'alphabet' }

  const prefix = REALM_PREFIX.exec(raw)
  const path = prefix === null ? raw : raw.slice(prefix[0].length)
  if (path.length === 0) return { ok: false, reason: 'empty-segment' }

  const segments = path.split('/')
  for (let index = 0; index < segments.length; index += 1) {
    // A leading empty segment is the root marker of an absolute path such as
    // `/srv/app/**`, and only when no realm prefix was consumed. An empty
    // segment anywhere else came from `//` or a trailing slash, and neither
    // says what it reaches.
    if (segments[index] === '' && (index !== 0 || prefix !== null)) return { ok: false, reason: 'empty-segment' }
    if (segments[index].includes('**') && segments[index] !== UNBOUNDED_SEGMENT) {
      return { ok: false, reason: 'partial-unbounded' }
    }
  }

  let wildcards = 0
  let unbounded = false
  for (const segment of segments) {
    if (segment.includes('*')) wildcards += 1
    if (segment === UNBOUNDED_SEGMENT) unbounded = true
  }

  return { ok: true, scope: { pattern: raw, segments: segments.length, wildcards, unbounded } }
}
