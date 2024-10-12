# agent-permission-map

Map declared agent tools to resource scope, data class, role and approval
condition, and produce a versioned permission matrix with the list of
assumptions the run could not make.

**This tool modifies no account.** It reads three JSON documents and writes a
report; with `--out` it also writes one matrix document at a path you name and
it checks first. It grants nothing, revokes nothing, contacts no provider, opens
no socket and holds no credential. A row in the matrix is a statement about
three exported documents, never about a live system.

**Unknown is never a pass.** A data class nobody declared, a role nobody
declared, a scope that could not be measured, a word outside a ladder, or a
capability and sensitivity pair no requirement governs, leaves that tool
`undecided`, lists the assumption, and exits 2. The permissive reading of an
absent declaration is exactly the reading that turns an unreviewed permission
into a green build.

- **Repository:** [edilec/agent-permission-map](https://github.com/edilec/agent-permission-map)
- **Area:** Prompt & Agent Workflows
- **License:** MIT
- Node ESM, `node >= 22`, no runtime and no development dependencies.

## Install and run

```sh
npx agent-permission-map --root ./declarations
```

```sh
agent-permission-map --root examples/clean
agent-permission-map --root examples/broad --json | jq '.matrix.rows[] | {id, verdict, reasons}'
agent-permission-map --root examples/clean --out ./matrix.json --out-root .
```

stdout carries the JSON report and nothing else, so it can be piped straight
into a parser. The human summary and every diagnostic go to stderr, which means
a non-empty stderr on a successful run is correct rather than a symptom.

| Exit | Meaning |
| ---: | --- |
| `0` | The declarations were mapped and nothing contradicted the policy. |
| `1` | They were mapped and at least one error-severity rule fired. |
| `2` | Invalid configuration or a refused `--out` (nothing on stdout), or evidence that could not be obtained (an `incomplete` report on stdout, never a `pass`). |

## Input

Three documents in one directory. Every one declares `"schemaVersion": "1"`, and
an unknown key anywhere is refused rather than ignored so a typo cannot disable
a check.

```
declarations/
  tools.json    the agent tools: capability, scopes, data classes, roles, approval
  roles.json    the roles that may run them, with their ceilings
  policy.json   the policy version, the data classes, and the approval requirements
```

```json
// tools.json
{ "schemaVersion": "1", "tools": [
  { "id": "tickets.reply", "capability": "write",
    "scopes": ["helpdesk://acme/tickets/*"],
    "dataClasses": ["support.tickets"],
    "roles": ["support-agent"],
    "approval": "per-action" }
] }
```

```json
// roles.json
{ "schemaVersion": "1", "roles": [
  { "id": "support-agent", "maxCapability": "write", "maxSensitivity": "internal" }
] }
```

```json
// policy.json
{ "schemaVersion": "1", "version": "2026-09-1",
  "dataClasses": [ { "id": "support.tickets", "sensitivity": "internal" } ],
  "requirements": [
    { "capability": "write", "sensitivity": "internal", "approval": "per-action",
      "maxScopeWildcards": 1, "unboundedScope": "forbidden" } ] }
```

`docs/permission-rules.md` is the full dialect, the rule catalog and the limits.

### The three ladders

| Ladder | Weakest → strongest |
| --- | --- |
| `capability` | `read`, `write`, `execute`, `delete`, `admin` |
| `sensitivity` | `public`, `internal`, `confidential`, `restricted` |
| `approval` | `none`, `per-session`, `per-action`, `two-person` |

Each is closed. A word outside a ladder is refused and recorded as an assumption
the run could not make — never mapped onto the nearest word that looks similar,
because the convenient guess for a permission map is always the permissive one.

### How an overly broad scope becomes visible

A scope is an optional `scheme://` realm followed by `/`-separated segments. Two
things are measured: how many segments carry a `*`, and whether any segment is
`**`, which reaches every resource below it however many there are and whatever
is added later.

The policy decides what is too broad, per capability and sensitivity pair, so a
wide read can be permitted while a wide delete is refused:

```json
{ "capability": "write", "sensitivity": "internal", "approval": "per-action",
  "maxScopeWildcards": 1, "unboundedScope": "forbidden" }
```

```
ERROR   tools.json/tools/1/scopes scope-unbounded Tool "tickets.read" declares the
        unbounded scope "helpdesk://**" for read internal, which the policy forbids.
ERROR   tools.json/tools/2/scopes scope-too-broad Tool "tickets.reply" declares the
        scope "helpdesk://*/tickets/*" with 2 wildcard segment(s) for write internal,
        above the 1 the policy allows.
```

The breadth of every scope reaches the matrix row whether or not it was refused,
so a reviewer can see what each tool reaches without reading the findings.

## Output

```json
{
  "schemaVersion": "1",
  "tool": "agent-permission-map",
  "status": "fail",
  "summary": {
    "checked": 3, "errors": 5, "warnings": 0,
    "tools": 3, "roles": 2, "dataClasses": 2, "requirements": 3,
    "withinPolicy": 1, "outsidePolicy": 2, "undecided": 0,
    "overbroadScopes": 2, "assumptions": 0
  },
  "matrix": {
    "schemaVersion": "1",
    "version": "2026-09-1",
    "rows": [
      { "id": "tickets.reply", "capability": "write", "sensitivity": "internal",
        "dataClasses": ["support.tickets"], "roles": ["support-agent"],
        "scopes": [ { "pattern": "helpdesk://*/tickets/*", "segments": 3,
                      "wildcards": 2, "unbounded": false } ],
        "declaredApproval": "none", "requiredApproval": "per-action",
        "verdict": "outside-policy",
        "reasons": ["approval-below-requirement", "scope-too-broad"] }
    ],
    "assumptions": [],
    "digest": "2ffb7ee2…"
  },
  "findings": []
}
```

| Verdict | Meaning |
| --- | --- |
| `within-policy` | No error-severity rule fired against this tool. A warning may still be attached. |
| `outside-policy` | At least one error-severity rule fired against it. |
| `undecided` | Evidence was missing. Never a pass, always `incomplete`, always listed in `matrix.assumptions`. |

### The matrix is versioned

`matrix.version` is the `version` the policy declares, and `matrix.digest` is a
SHA-256 over the matrix body. The digest is computed from the matrix alone — no
clock, no host, no run id — so two runs over the same declarations produce the
same digest, and any change to a scope, a role, a verdict or an assumption
produces a different one. That is what makes it usable as the thing a review
signs off and a later run is compared against.

A policy with no `version` produces `"version": null` and an `incomplete` run: a
map of who may do what, with nothing saying which revision it came from, is a
map nobody can compare against the next one.

### Writing it out

`--out FILE` writes the versioned matrix document; the report still goes to
stdout. The destination is checked before anything is read and long before
anything is written: a symbolic link at the destination is refused on sight, a
parent that resolves outside `--out-root` (default: the current working
directory) is refused, and a destination that is the same file as one of the
three inputs — including through a hard link, which shares no path with it and
resolves to nothing — is refused. A refused destination is a configuration
error: stdout stays empty and the exit code is 2.

## Examples

```sh
npm run example                                  # examples/clean, exits 0
node bin/agent-permission-map.mjs --root examples/broad        # exits 1
node bin/agent-permission-map.mjs --root examples/incomplete   # exits 2
```

- `examples/clean` — three tools, every one within the policy.
- `examples/broad` — an unbounded scope, a scope with two wildcards where one is
  allowed, an unattended write where per-action is required, and a grant to a
  read-only role.
- `examples/incomplete` — a tool naming a data class the policy does not
  declare, so its sensitivity is unknown and the run cannot pass.

## Limits and non-goals

Every limit is enforced and named when it is reached, and exceeding one makes
the run `incomplete` rather than truncating silently. The defaults and their
caps are in `docs/permission-rules.md`.

This tool **cannot** tell you:

- **Whether a provider agrees with the declarations.** No account is contacted
  and no credential is held. A tool declared with a narrow scope here may hold a
  wide grant in the system it was exported from.
- **Whether a scope matches any particular resource.** Breadth is measured from
  the pattern. There is no resource list and no matching.
- **Whether an approval was ever collected.** `approval` is a declaration about
  what the workflow requires, not evidence that anybody approved anything.
- **Whether the ladder order is right for your organisation.** It is a declared
  convention of this build, written down so you can disagree with it
  deliberately.
- **Whether the policy is a good policy.** The tool checks three declarations
  against each other; nothing here knows what your agents ought to be allowed to
  do.

It also does not execute, grant, revoke, rotate or request anything. Static
analysis of declared configuration is the whole of it.

## Development

```sh
npm run check     # lint, test, run the example, and npm pack --dry-run
npm test
npm run lint
```

No runtime and no development dependencies. The test suite pins the guarantees
this README makes rather than the declarations behind them: severity by process
exit code, ordering by emitted sequence, the write guard by one case per hole
plus the allowed cases, and "modifies no account" by a byte-for-byte snapshot of
the input tree around every run.

## License

MIT. See [LICENSE](./LICENSE).
