# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Rule ids are
part of the public surface: renaming one is a breaking change and is recorded
here.

## [Unreleased]

### Added

- First implementation of `agent-permission-map`: reads declared agent tools,
  the roles that may run them, and the approval policy that governs them, and
  produces a versioned permission matrix plus the list of assumptions the run
  could not make. It modifies no account, grant or policy.
- Scope breadth measured from the declared pattern -- wildcard segments, and
  whether any segment is the unbounded `**` -- and judged against the
  requirement that governs the tool, so a policy can permit a wide read and
  refuse a wide delete. The measured breadth reaches the matrix row whether or
  not it was refused.
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
- A 48-rule catalog with one frozen `ruleId -> severity` table, documented in
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

No release has been published.
