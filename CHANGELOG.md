# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Rule ids are
part of the public surface: renaming one is a breaking change and is recorded
here.

## [0.1.0] - 2026-09-28

### Fixed

- A tool refused by a closed ladder no longer vanishes. It used to be dropped
  entirely -- no matrix row, no assumption, `undecided: 0` -- while the README,
  the rule catalog and the help text all said it was left `undecided` with the
  assumption listed. The matrix `--out` wrote then showed only the surviving
  tools, all `within-policy`, with nothing in the artefact saying a declared
  tool had been refused. Such an entry now reaches the matrix as an `undecided`
  row carrying the rule that refused it, with its assumption listed; an entry
  that declared no usable id reaches it as the assumption alone.
- `summary.tools` is the count `tools.json` declares rather than the count that
  compiled, so the human summary can no longer print "2 of 2 declared tool(s)
  mapped" over a document declaring three. `summary.toolsRefused` reports the
  difference.
- `matrix.status` records the status of the run that produced the document, and
  is inside the digest. `--out` used to write a signed matrix of
  `within-policy` rows from a run that had exited 2, with the only warning on a
  stderr line that `--json` suppresses.
- A tool whose every scope, data-class reference or role reference was refused
  is no longer reported as declaring none. `tool-scopes-unreadable`,
  `tool-data-classes-unreadable` and `tool-roles-unreadable` say what actually
  happened; the old `tool-declares-no-scope`, `tool-declares-no-data-class` and
  `tool-grants-no-role` messages asserted an absence that was false and sent a
  reviewer looking for a declaration that was sitting in the file. The role case
  was the mildest of the three and so the easiest to miss: `tool-grants-no-role`
  is a `warning` about a dead declaration, so an unread grant was being reported
  as a harmless one.
- Matrix rows carry `dataClassesRefused`, `rolesRefused` and `scopesRefused`. A
  reference or pattern the build could not read cannot appear in the list
  beside it, and a list that simply lost it said the tool reaches less than it
  declares.
- `role-grants-nothing` stays silent when any grant went unread -- a tool entry
  whose whole `roles` list was refused, and a compiled entry with a refused
  member in an otherwise good list. "Granted no tool" is an absence, and it
  cannot be established from a document whose grants were not all read: the
  reference nobody could read may be the one that granted this role.
- `location.file` and `location.pointer` are no longer passed through
  `excerpt`, which collapses runs of whitespace and trims. A file named
  `my  tools.json` was reported as `my tools.json`, and a consumer resolving
  the path the report contract promises is relative to the input root got
  ENOENT.
- A value that cannot be converted to a string -- `{"toString": {}}` parses out
  of JSON and throws on `String(value)` -- is described by its shape,
  `[object]` or `[array]`, instead of taking the whole run down with an empty
  stdout at exit 2.
- An id is claimed by the entry that declares it whether or not the rest of
  that entry compiles, so a refused entry and a later good one can no longer
  both carry the same id.

### Added

- First implementation of `agent-permission-map`: reads declared agent tools,
  the roles that may run them, and the approval policy that governs them, and
  produces a versioned permission matrix plus the list of assumptions the run
  could not make. It modifies no account, grant or policy.
- Scope breadth measured from the declared pattern -- wildcard segments, and
  whether any segment is the unbounded `**` -- and judged against the
  requirement that governs the tool, so a policy can permit a wide read and
  refuse a wide delete. Every scope the run could measure reaches the matrix
  row, and `scopesRefused` beside it says how many could not be.
- Three closed ladders (`capability`, `sensitivity`, `approval`) whose order is
  documented as a convention of this build. A word outside a ladder is refused
  and recorded as an unsupported assumption, never mapped onto the nearest word
  that looks similar: for a permission map the convenient guess is always the
  permissive one.
- Unknown treated as undecided everywhere it arises -- an undeclared data class
  or role, an unmeasurable scope, an empty `dataClasses` or `scopes` list, a
  capability and sensitivity pair no requirement governs, and a pair two
  requirements both claim. Each leaves the tool `undecided`, lists the
  assumption, and exits 2.
- A versioned matrix: the policy revision travels with it and a SHA-256 digest
  over the matrix body identifies it, computed with no clock, host or run id, so
  two runs over the same declarations produce the same digest and any change to
  a scope, role, verdict or assumption produces a different one. A policy with
  no `version` produces a null version and an `incomplete` run.
- A 50-rule catalog with one frozen `ruleId -> severity` table, documented in
  `docs/permission-rules.md` and pinned behaviourally: every error rule is
  driven through the real binary and asserted by process exit code, and every
  warning rule is asserted to exit 0, so neither direction can drift.
- Enforced limits on bytes, tools, roles, data classes, requirements, scopes per
  tool, references per tool, findings and runtime, each reported by name when
  reached and each making the run `incomplete` rather than truncating silently.
  The time budget is re-checked *after* the row loop returns, and every verdict
  it reached is withdrawn to `undecided` when it has been passed.
- A CLI with `--help`, `--json`, explicit input paths, `--out`/`--out-root` for
  the matrix document, and the three documented exit codes; the JSON report on
  stdout alone.
- Examples for a clean declaration set, one with an overly broad scope, and one
  that cannot be decided.

### Security

- Read-only over its inputs, and proved so: a byte-for-byte snapshot of the
  input tree around runs that pass, fail and report incomplete, plus a source
  read that names every file-system import and asserts the package's only
  writing verb is the guarded destination write.
- The `--out` destination is checked before anything is read and long before
  anything is written, against all three independent holes: a symbolic link at
  the destination (refused on sight with `lstat`, because `realpath` would
  resolve it and resolving is the dangerous act), a parent that resolves outside
  `--out-root`, and a destination that is the same file as any of the three
  inputs through a hard link, which shares no path with them and resolves to
  nothing. The input set passed to the guard is every file the run may open, not
  only the primary one. The allowed cases are pinned too, including a symlinked
  parent that stays inside the root, because a guard that refuses everything
  passes every data-loss test while making the tool useless.
- No network access of any kind. Proved by a module-resolution guard that
  refuses every network builtin, with a control run proving the guard fires, and
  by a live loopback listener whose address is planted in a scope and in a
  description and never contacted.
- No account, credential or environment surface is read at all: the package
  imports `node:crypto`, `node:fs/promises`, `node:path`, `node:perf_hooks` and
  `node:process`, and nothing else.
- Path confinement resolves the real path of both the root and each input, so a
  symlink planted inside the root is refused while a legitimate file under a
  symlinked root is not.
- Strict UTF-8 decoding on every input, with no inference drawn from decoded
  text.
- Control (C0), DEL, C1, line and paragraph separator and bidi characters are
  stripped from every untrusted string that reaches output -- identifiers,
  scopes, pointers, messages and evidence alike -- and the human summary is
  pinned to an exact line count so a newline arriving through an identifier
  cannot forge a line. A value the tool refuses is described rather than
  reproduced, and an unknown key is counted rather than named.
- A parse failure does not quote the file it failed on. V8 writes
  `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, so a
  declaration file short enough to be nothing but a credential would otherwise
  be reproduced in full on stdout. The helper recognises the quoting shape
  *before* looking for a position -- a document whose own text reads
  `at position 1` is answered by V8 with that text inside the quoted span, and a
  position-first helper slices the document back out -- matches across a line
  break, and discards any detail still carrying a double quote.
- Ordering is by UTF-16 code unit everywhere and pinned by the emitted sequence
  rather than by a source scan, because `Intl.Collator` collates identically to
  `localeCompare` and spells differently.

First public source release; this package is not published to npm.
