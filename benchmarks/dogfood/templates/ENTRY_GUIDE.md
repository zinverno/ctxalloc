# Local human intake worksheet

These are blank field descriptions, not evaluation cases or judgments. Copy the
three JSON templates into an ignored experiment directory. Fill them from approved
real material. Do not replace missing human judgments with generated examples.

`settings.json` describes one explicit snapshot and operating point. All top-level
fields are required; `null` means an operator decision is still missing. Preparation
needs source approval, scope, snapshot root, languages, source entries, reader size
limit and both chunking configurations. Freeze additionally requires the remaining
operating and collection settings. No production values are inferred.

- `scope`: the existing `{tenantId, workspaceId, projectId?}` domain shape.
- `snapshotRoot`: relative to the settings file, resolving inside `.ctxalloc/`.
- `readerMaxBytes`: positive integer; total source text is additionally bounded by
  the pilot's 2,000,000-byte safety limit.
- `markdownChunking`, `textChunking`: `{targetTokens, maxTokens}`, validated by the
  existing owners. Conversation uses one block per actual message.
- `availableTokens`, `reservedOutputTokens`: explicit integers; reserve may be zero.
  Total compiler tokens = available + output reserve. Account for any other
  production reserves before supplying available tokens.
- `maxCandidates`: actual production cap; not the maximum corpus size for diagnostics.
- `referenceTime`: explicit ISO timestamp, never inferred from file modification time.
- `collectionRule`: collection interval, eligibility/exclusion rules, scope and any
  predeclared supplementary cohort. `languages`: declared source/query language codes.
- `toolResultsAvailable`: whether approved real exported tool results are available.
- `experimentId`, `sourceApprovalReference`: local identifiers for this experiment
  and the operator's actual source-scope approval. A string is not proof of consent.

Append one entry per approved source to `sources`:

```json
{
  "id": null,
  "locator": null,
  "sourceType": null,
  "origin": null,
  "language": null,
  "available": null
}
```

Use a stable logical ID, an explicit relative file locator and an honest existing
kind (`markdown`, `text`, `conversation`). Origins are `project-documentation`,
`developer-reference`, `conversation-history`, or `tool-result`. Documentation
uses Markdown; conversation history must use actual conversation JSON. Tool
results are exported Markdown/text, not executed tools. For unavailable sources,
set `available:false` and `locator:null`; keep their identities and annotations.
An available file must have a locator. There are no globs or embedded imports.

Conversation JSON uses the existing v1 source format, with `schemaVersion:1` and
`messages` containing exact `id` and `content` strings. Optional timestamps and
metadata follow the existing application schema. Roles, tool calls, attachments
and arbitrary export envelopes are not supported. Document any approved manual
export conversion; relabeling the query as a message does not create history.

`tasks.json` contains a local `collectionRecord` documenting the actual sampling
process, and a `tasks` array. Each task entry has:

```json
{
  "id": null,
  "query": null,
  "language": null,
  "strata": [],
  "runtime": []
}
```

Strata use the source-origin vocabulary above, assigned before retrieval; real
multi-source tasks may appear in more than one. Every declared query-language
stratum is also reported. All tasks search the same explicitly approved snapshot
and exact scope. Different project scopes require separately identified runs.

`runtime` is an explicit empty list or genuine caller-known obligations. Each
obligation has `id`, exact `content`, and a `basis` describing the caller contract
that already made it mandatory. Never derive this list from evaluator usefulness,
criticality, required facts, scores or results. The query is not added automatically.

`annotations.json` has process fields and one annotation per task. Set `kind` to
`human` only for actual human annotations. Record the actual author and method,
what they could see, independence from retrieval/selection output, and explicit
approval to evaluate. Single-person review must be described as such. Booleans,
hashes and process strings cannot establish real authorship or consent.

Each annotation entry has:

```json
{
  "taskId": null,
  "answerability": null,
  "scopeReviewed": false,
  "useful": [],
  "irrelevantBlockIds": [],
  "facts": []
}
```

Answerability is `answerable`, `unanswerable`, or `insufficient-source`. A human
unanswerable task has no positive evidence/facts; it still requires full scope
review and does not automatically make every block negative. Insufficient-source
cases retain missing evidence/facts. Unmarked blocks remain unjudged.

Append useful source carriers to `useful`. Each has `id`, `sourceId`, `location`
and the exact `quote`. Text locations use the existing domain shape
`{kind:"text-range", startOffset, endOffset}` with UTF-16 offsets; conversation
locations use `{kind:"conversation-message", messageId, messageIndex?}` and quote
the entire exact message. Use the score-free worksheet to find identities and
locations. Record only source-supported human judgments. For unavailable material,
keep its source ID and set both location and quote to null.

Spans may need several prepared chunks. Every non-whitespace source code unit
must be covered for full evidence preservation. Partially surviving chunks remain
positively judged for candidate precision, while the incomplete evidence unit
retains its preparation loss. Exact source/quote mismatches are input defects.

`irrelevantBlockIds` contains independently judged wholly irrelevant prepared IDs
from the worksheet. A block carrying part of useful evidence cannot also be
wholly irrelevant. At least 80% of prepared blocks per task must be judged for the
pilot completeness gate; remaining uncertainty is still reported.

Each fact has `id`, a human-authored `statement`, evaluator-only `required`, nullable
`critical`, and `alternatives`. Each alternative is a list of useful carrier IDs:
all carriers within one alternative are needed; any complete alternative suffices.
An empty alternatives list means no available supporting carrier, not an omitted
fact. Criticality null means unknown. Required/critical flags never change runtime
attributes, priorities, ranking, applicability, admission or budgets.

Keep worksheets and annotations local. The existing Phase 22A bounded JSON reader
is shared; its original presegmented dataset format remains unchanged. Source
snapshots and multi-carrier annotations use this new strict workflow schema, not
`development:retrieval`'s presegmented corpus shortcut.
