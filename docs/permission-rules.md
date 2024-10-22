# Rule catalog, limits and the supported dialect

What `agent-permission-map` reads, what each rule means, what it refuses, and
what it cannot tell you. The README is the short version; this file is the one
to read before changing a rule id or a severity, because both are part of the
public surface.

**This tool modifies no account.** It reads three JSON documents and writes a
report, and with `--out` one matrix document at a path you name and it checks
first. It grants nothing, revokes nothing, contacts no provider and holds no
credential.

## Input dialect

Three documents in one directory. Every one declares `"schemaVersion": "1"`, and
an unknown key anywhere is refused rather than ignored, so a typo cannot disable
a check.

```
declarations/
  tools.json    the agent tools: capability, scopes, data classes, roles, approval
  roles.json    the roles that may run them, with their ceilings
  policy.json   the policy version, the data classes, and the approval requirements
```

### `tools.json` — what each tool declares

```json
{ "schemaVersion": "1", "tools": [
  { "id": "tickets.reply",
    "capability": "write",
    "scopes": ["helpdesk://acme/tickets/*"],
    "dataClasses": ["support.tickets"],
    "roles": ["support-agent"],
    "approval": "per-action",
    "description": "Posts a reply on a support ticket" }
] }
```

Keys: `approval`, `capability`, `dataClasses`, `description`, `id`, `roles`,
`scopes`. Every one but `description` is required, and an omitted list is
refused rather than read as an empty one — "no roles are declared" and "the
field is missing" are different facts, and reading the second as the first is
how an absent declaration becomes a permissive one.

### `roles.json` — who may run a tool, and how far

```json
{ "schemaVersion": "1", "roles": [
  { "id": "support-agent", "maxCapability": "write", "maxSensitivity": "internal" }
] }
```

Keys: `description`, `id`, `maxCapability`, `maxSensitivity`.

### `policy.json` — the version, the classes and the requirements

```json
{ "schemaVersion": "1",
  "version": "2026-09-1",
  "dataClasses": [ { "id": "support.tickets", "sensitivity": "internal" } ],
  "requirements": [
    { "capability": "write", "sensitivity": "internal",
      "approval": "per-action", "maxScopeWildcards": 1, "unboundedScope": "forbidden" }
  ] }
```

Keys: `dataClasses`, `requirements`, `schemaVersion`, `version`. A data class
carries `description`, `id`, `sensitivity`; a requirement carries `approval`,
`capability`, `description`, `maxScopeWildcards`, `sensitivity`,
`unboundedScope`.

`version` is a required identifier. The matrix is stamped with it, and a matrix
that does not say which revision of the policy it came from is one nobody can
compare against the next one, so a run without it is `incomplete`.

### Names

An id is 1–120 characters from `[A-Za-z0-9._:/+-]`, starting with a letter or a
digit. A value that would merely print as an id — one carrying a control, a
line separator or a bidi override — is refused at the door rather than cleaned
up and used, because an id whose printed form differs from the id the map
compared is an id nobody can audit.

## The three ladders

Each vocabulary is closed. A word outside a ladder is refused and recorded as an
assumption the run could not make; it is never mapped onto the nearest word that
looks similar, because for a permission map the convenient guess is always the
permissive one.

Refusing the word does not drop the tool. The entry reaches the matrix as an
`undecided` row carrying the rule that refused it, and the assumption is listed
against its pointer, so a reviewer reading the matrix alone sees that a declared
tool was not mapped. A tool that declared no usable `id` has nothing to name a
row with and reaches the matrix as the assumption alone.

| Ladder | Weakest → strongest |
| --- | --- |
| `capability` | `read`, `write`, `execute`, `delete`, `admin` |
| `sensitivity` | `public`, `internal`, `confidential`, `restricted` |
| `approval` | `none`, `per-session`, `per-action`, `two-person` |

The capability order is a declared convention of this build rather than a fact
about the world: `read` observes, `write` changes what is there, `execute` runs a
declared action with effects outside the store, `delete` destroys, and `admin`
changes who may do any of the four. Moving a word changes verdicts and is a
breaking change.

## How a scope is measured

A scope is a resource pattern: an optional `scheme://` or `scheme:` realm
followed by `/`-separated segments. Two numbers are measured and neither is
judged here:

- **`wildcards`** — how many segments contain `*`. `helpdesk://*/tickets/*` has
  two.
- **`unbounded`** — whether any segment is exactly `**`, which reaches every
  resource below it, however many there are and whatever is added later.

What counts as too broad is a property of the requirement that governs the tool,
not of the measurement, which is why a policy can permit a wide read and refuse
a wide delete. A scope with an empty segment (from `//` inside the path or a
trailing `/`), a `**` mixed with other text in one segment, a character outside
`[A-Za-z0-9._:/+*@-]`, or more than 200 characters, is refused: its breadth was
not measured, so what the tool reaches is only partly known and the run is
`incomplete`.

Nothing in this package expands a pattern against a resource list. It has no
resource list. It reads declarations, and a declaration is all it reports on.

## Which requirement governs a tool

A tool's sensitivity is the **highest** of the data classes it declares. The
requirement that governs it is the one whose `capability` and `sensitivity` are
exactly that pair. If no requirement governs the pair, the tool is `undecided`
and the run is `incomplete` — it is never read as unrestricted. If two
requirements govern the pair, neither is authoritative, so the pair is not used
at all and every tool it governs is `undecided`.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `within-policy` | Every error-severity rule that could apply to this tool did not fire. A warning may still be attached. |
| `outside-policy` | At least one error-severity rule fired against it. |
| `undecided` | Evidence was missing. Never a pass, always `incomplete`, always listed in `matrix.assumptions`. |

A row also carries `dataClassesRefused`, `rolesRefused` and `scopesRefused`. A
reference or a pattern this build could not read cannot appear in the list
beside it — reading it is what failed — and a list that simply lost it would
say the tool reaches less than it declares. The count is what makes the list
honest about being partial.

## Rule catalog

Severity comes from one frozen table in `src/rules.mjs`, and an unknown rule id
throws rather than being emitted. The severities below are the same table, and
`test/severity-table.test.mjs` asserts the two against each other in both
directions. That is not the test that defends them: `test/severity-exit.test.mjs`
drives a real input through the real binary for every rule here and pins the
process exit code, because three declarations can be edited together and an exit
code cannot be edited at all.

Five rules are below `error`, and each is a legitimate state rather than a
defect.

### Input and document

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unreadable` | error | A document could not be reached or read. |
| `input-not-utf8` | error | A document is not valid UTF-8. The decoder decides; the decoded text never gets a vote. |
| `input-not-json` | error | A document is not valid JSON. The finding carries the position, line and column of the failure and never the text at it: V8 quotes the input back in its own parse message, so a file short enough to be nothing but a credential would otherwise be reproduced in full by its own error. |
| `input-too-large` | error | A document is past `maxFileBytes` and was not read. |
| `path-escapes-root` | error | A document resolves outside `--root` and was refused unread. |
| `document-invalid` | error | A document is not an object, declares an unknown key, or its list is not an array. |
| `schema-version-unsupported` | error | A document declares a `schemaVersion` this build does not implement. |
| `policy-version-invalid` | error | `policy.json` declares no usable `version`, so the matrix is unversioned. |

### Entries

| Rule | Severity | Meaning |
| --- | --- | --- |
| `identifier-invalid` | error | An entry has no usable id. |
| `tool-invalid` | error | A tool entry is not an object, declares an unknown key, an over-long description, or a reference list that is not an array. |
| `tool-duplicate` | error | Two tools declare the same id; neither is authoritative, so the second was refused. |
| `role-invalid` | error | A role entry is not an object or declares an unknown key. |
| `role-duplicate` | error | Two roles declare the same id. |
| `data-class-invalid` | error | A data-class entry is not an object or declares an unknown key. |
| `data-class-duplicate` | error | Two data classes declare the same id. |
| `requirement-invalid` | error | A requirement is not an object, declares an unknown key, an unsupported `unboundedScope`, or a `maxScopeWildcards` outside 0–64. |
| `requirement-duplicate` | error | Two requirements govern the same capability and sensitivity pair, so the pair is not used and every tool it governs is undecided. |
| `capability-unsupported` | error | A `capability` or `maxCapability` is not on the capability ladder. |
| `sensitivity-unsupported` | error | A `sensitivity` or `maxSensitivity` is not on the sensitivity ladder. |
| `approval-unsupported` | error | An `approval` is not on the approval ladder. |
| `scope-invalid` | error | A scope could not be measured, so what the tool reaches is only partly known. |
| `scope-duplicate` | warning | A tool declares the same scope twice; the repeat reaches nothing the first does not and was dropped. |
| `class-reference-invalid` | error | A member of a `dataClasses` list is not a usable id. |
| `class-reference-duplicate` | warning | A data class is named twice in one list; the repeat was dropped. |
| `role-reference-invalid` | error | A member of a `roles` list is not a usable id. |
| `role-reference-duplicate` | warning | A role is named twice in one list; the repeat was dropped. |

### The map

| Rule | Severity | Meaning |
| --- | --- | --- |
| `scope-unbounded` | error | A tool declares a `**` scope for a pair whose requirement sets `unboundedScope: "forbidden"`. |
| `scope-too-broad` | error | A tool declares a scope with more wildcard segments than its requirement allows. |
| `approval-below-requirement` | error | A tool's declared approval is weaker than its requirement asks for. |
| `role-capability-exceeded` | error | A tool is granted to a role whose `maxCapability` is below the tool's capability. |
| `role-sensitivity-exceeded` | error | A tool reaches data above a granted role's `maxSensitivity`. |
| `data-class-unknown` | error | A tool names a data class the policy does not declare, so its sensitivity is unknown and was not guessed at. |
| `role-unknown` | error | A tool is granted to a role the role document does not declare, so that role's ceilings are unknown. |
| `requirement-missing` | error | No requirement governs the capability and sensitivity a tool declares. The tool is undecided rather than unrestricted. |
| `tool-declares-no-data-class` | error | A tool declares an empty `dataClasses` list, so which requirement governs it is unknown. An empty list is not read as "public data". |
| `tool-data-classes-unreadable` | error | A tool names data classes and every one of them was refused. Not the same fact as declaring none, and never reported as that one. |
| `tool-declares-no-scope` | error | A tool declares an empty `scopes` list, so what it reaches is unknown. An empty list is not read as "nothing". |
| `tool-scopes-unreadable` | error | A tool declares scopes and none of them could be measured. Not the same fact as declaring none, and never reported as that one. |
| `tool-grants-no-role` | warning | A tool is granted to no role, so nothing declared here can run it. A dead declaration rather than a wider permission. |
| `role-grants-nothing` | warning | A role is granted no tool. |

### Bounds and vacuity

| Rule | Severity | Meaning |
| --- | --- | --- |
| `too-many-tools` | error | `tools.json` declares more tools than `maxTools`; nothing was compiled from it. |
| `too-many-roles` | error | `roles.json` declares more roles than `maxRoles`. |
| `too-many-data-classes` | error | `policy.json` declares more data classes than `maxDataClasses`. |
| `too-many-requirements` | error | `policy.json` declares more requirements than `maxRequirements`. |
| `too-many-scopes` | error | One tool declares more scopes than `maxScopes`; none of them were read. |
| `too-many-class-references` | error | One tool names more data classes than `maxClassReferences`. |
| `too-many-role-references` | error | One tool names more roles than `maxRoleReferences`. |
| `too-many-findings` | error | The run produced more findings than `maxFindings`; the report is partial and says so. |
| `time-budget-exceeded` | error | The mapping passed `maxRuntimeMs`. Every verdict it had reached is withdrawn to `undecided`. |
| `no-tools-evaluated` | error | Three documents compiled and no tool was left to map, so the run has no evidence to be green on. |

## Limits

| Limit | Default | Cap | Flag |
| --- | ---: | ---: | --- |
| `maxFileBytes` | 5242880 | 67108864 | `--max-file-bytes` |
| `maxTools` | 500 | 20000 | `--max-tools` |
| `maxRoles` | 200 | 5000 | `--max-roles` |
| `maxDataClasses` | 200 | 5000 | `--max-data-classes` |
| `maxRequirements` | 400 | 5000 | `--max-requirements` |
| `maxScopes` | 64 | 1024 | `--max-scopes` |
| `maxClassReferences` | 64 | 1024 | `--max-class-references` |
| `maxRoleReferences` | 64 | 1024 | `--max-role-references` |
| `maxRuntimeMs` | 10000 | 600000 | `--max-runtime-ms` |
| `maxFindings` | 1000 | 20000 | `--max-findings` |

A caller may lower a limit and never raise it past its cap. An unknown limit key
is refused rather than ignored, because a documented bound that a typo silently
disables is a bound that is not enforced. Exceeding a limit is never a silent
truncation: it produces a finding naming the limit and marks the run
`incomplete`.

There is no recursion limit because the input has no recursive shape: the
deepest structure read is an array of objects holding arrays of strings, and
each of those is bounded by name above.

## Status, exit codes and ordering

| Status | Exit | Meaning |
| --- | ---: | --- |
| `pass` | 0 | Every declared tool was mapped and no error-severity rule fired. |
| `fail` | 1 | Every declared tool was mapped and at least one error-severity rule fired. |
| `incomplete` | 2 | Evidence was missing, refused, truncated or undecided. Never interchangeable with `pass`. |

A configuration error — an unknown option, a missing `--root`, a refused `--out`
— exits 2 with an **empty stdout**, because a run that never had a subject has
nothing to report about. An input that could not be read exits 2 with an
`incomplete` report on stdout, because the run had a subject and failed to
obtain evidence about it, and a consumer needs to know which document that was.

Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then
`message`. Matrix rows sort by `id`; assumptions by `file`, `pointer`,
`assumption`; every list inside a row by its own value. Every comparison is by
UTF-16 code unit. `localeCompare` and `Intl.Collator` appear nowhere in this
package: both consult ICU data that differs between Node builds, so two correct
machines would disagree about the same output.

No wall clock reaches the report. The only clock is the injected monotonic one
the time budget uses, which is why two runs over identical inputs produce
byte-identical stdout.

## Writing the matrix

`--out` writes the versioned matrix document. The document carries `status` —
the status of the run that produced it, inside the digest — because it is
written on its own and read on its own: the exit code is not in the file, and
the stderr warning an incomplete run prints is suppressed by `--json` and never
reaches a consumer reading the artefact.

It is checked before anything is read and long before anything is written:

- a destination that **is a symbolic link** is refused on sight, because
  `realpath` would resolve it and resolving is the dangerous act;
- a destination whose **parent resolves outside `--out-root`** (default: the
  current working directory) is refused, because a lexical prefix check passes
  for `root/link/out`;
- a destination that is the **same file as one of the three inputs** — including
  through a hard link, which shares no path with it and resolves to nothing — is
  refused, because only device plus inode can see that.

A refused destination is a configuration error: stdout stays empty and the exit
code is 2. The matrix is written before the report reaches stdout, so a write
that fails also leaves stdout empty rather than reporting success for an
artefact nobody has.

## What this tool cannot tell you

- **Whether a provider agrees with the declarations.** No account is contacted
  and no credential is held. A tool declared with a narrow scope here may hold a
  wide grant in the system it was exported from, and this tool has no way to
  know that.
- **Whether a scope matches any particular resource.** Breadth is measured from
  the pattern. There is no resource list and no matching.
- **Whether an approval was actually collected.** `approval` is a declaration
  about what the workflow requires, not evidence that anybody approved anything.
- **Whether the ladder order is right for your organisation.** It is a declared
  convention of this build, written down above so you can disagree with it
  deliberately.
- **Whether the policy is a good policy.** The tool checks the declarations
  against each other. Nothing here knows what your agents ought to be allowed to
  do.
