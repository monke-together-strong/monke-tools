# Finding envelope (subagent contract)

You are one per-repo subagent. You receive a **bundle JSON** for a single repo plus the current
entries from `~/.monke/agent-retrospectives/accepted.md`. Read the bundle, inspect relevant files,
find evidenced improvements, and write
a **findings JSON** to the sibling path (same directory, filename with `<repoHash>.json` →
`<repoHash>.findings.json`).

Read [Matt's retrospective guidance](../../../imported/retro/SKILL.md) for improvement categories
and guidance placement. Analyze the supplied bundle and write this contract's findings; the local
retrospective workflow owns collection, evidence eligibility, and final presentation.

The script owns identity and citation validation; you own everything substantive. Keep the
envelope thin and grounded; write free-form prose in `body`.

## Bundle you receive

```jsonc
{
  "repoKey": "/abs/source/root",
  "repoHash": "…",
  "sessions": [
    {
      "agent": "codex" | "claude",
      "sessionId": "…",
      "sourcePath": "/abs/path/to/transcript.jsonl",
      "contentHash": "…",          // SHA-256 of the source bytes at collection
      "threadSource": "user" | "subagent" | "automation" | "…" | null,
      "parentSessionId": "…" | null,
      "role": "primary" | "secondary",
      "firstNewTurnIndex": 0,        // analyze turns at this index and after
      "priorFindingCount": 0,
      "turns": [
        { "kind": "user" | "assistant", "ref": "t0", "sourceLine": 4, "text": "…" },
        { "kind": "tool_call", "ref": "t1", "name": "exec_command",
          "sourceLine": 8, "outputSourceLine": 11,
          "inputSummary": "…", "exitCode": 1, "error": "exit 1", "outputHeadTail": "…" }
      ],
      "rawUserMessages": ["…"]       // genuine human turns, for repeated-ask clustering
    }
  ],
  "priorFrictionDigest": ["abcd1234: …one-line prior friction…"]
}
```

Every turn has a stable `ref` (`t<n>`). Cite turns by their `ref`. `threadSource` identifies the
native origin category; `parentSessionId` links a delegated transcript to its parent when Codex
recorded one. A `primary` session is one whose cwd resolves to this repo, or whose missing cwd
inherits this repo from its parent. A `secondary` session touched this repo directly or inherited
it through its parent.

When a clipped turn leaves the evidence unclear, read its original JSONL record at `sourcePath`
and the one-based `sourceLine`; tool results have their own `outputSourceLine`. Blank and malformed
lines count toward these locations. Compare the file's SHA-256 with `contentHash` before relying
on the recorded positions. If the source has changed, verify the session and record identities
before using it. Older saved bundles may lack these pointers; report that limitation rather than
guessing a raw location. Keep the bundle's turn refs as the finding citations.

**Author friction episodes only for `primary` sessions.** A secondary session's friction belongs
to its own primary repo and is authored there — commit drops any episode citing a secondary
session. Read secondary sessions as supporting context for the repo's durable fixes, not as
episode sources.

## Findings you write

```jsonc
{
  "repoKey": "/abs/source/root",     // copy from the bundle
  "frictionEpisodes": [
    {
      "id": "e1",                     // unique within this file; fixes cite it
      "sessionId": "…",               // must be a sessionId from the bundle
      "citedTurnRefs": ["t14", "t15"],// must exist in that session; invalid → repair before commit
      "body": "Free-form: what the agent attempted, the blocker it hit, how it pivoted, the outcome."
    }
  ],
  "durableFixProposals": [
    {
      "citedEpisodeRefs": ["e1"],     // optional evidence route: episodes above
      "citedTurns": [                 // optional evidence route: direct transcript observations
        { "sessionId": "…", "citedTurnRefs": ["t14"] }
      ],
      "repositoryEvidence": [         // optional evidence route: inspected current files
        { "path": "/abs/repo/AGENTS.md", "revision": "HEAD or working tree", "excerpt": "Relevant inspected text" }
      ],
      "body": "Target: <where the fix lands — code | tooling | setup | infra | deps | docs | agent-skill | AGENTS.md | CLAUDE.md | hook | preflight>\nConfidence: high | medium | low\n\nThe inferred root cause and the concrete durable fix."
    }
  ],
  "repeatedAsks": [
    {
      "label": "short cluster name",
      "exampleSessionIds": ["…"],
      "body": "The recurring ask about how code should be written or changed, whether it looks like a standards candidate, and what would stop it recurring."
    }
  ]
}
```

## Rules

- Treat accepted entries as user-approved boundaries. Omit episodes, proposals, and repeated asks
  whose only problem is an accepted condition. A distinct consequence outside the named boundary
  remains eligible.
- A **friction episode** is concrete: a real attempt → blocker → pivot, anchored to cited turns.
  Not "the agent could have been faster" — that cites nothing.
- Lead every `durableFixProposal.body` with `Target:` and `Confidence:` lines. The body is prose;
  there are no other required fields.
- A proposal needs at least one evidence route: episodes, direct transcript turns, or inspected
  files. It may use several. Direct observations need no blocker or pivot; a missing guardrail is
  eligible when current inspection establishes the gap. Cite existing files with excerpts and name
  the inspected revision or installed surface. File paths may be absolute or relative to `repoKey`.
  The script checks file existence and citation structure; the worker owns whether an excerpt and
  proposed remedy are supported. Keep confidence and uncertainty explicit.
- **Describe observed consequences and independent recurrence; synthesis owns ranking.** A code, tooling, or setup fix is
  first-class — e.g. "`mt spawn` doesn't install deps / generate clients, so the agent runs the
  same workaround every session" is a high-value proposal, not a footnote. Name the actual landing
  surface even when a transcript says the fix already landed; current-state resolution belongs to
  the later synthesis audit, not this per-repo finding.
- Cite only refs that exist in the bundle. Invalid episodes, proposal evidence, and repeated-ask
  session ids block commit before any cursor advances. Repair the named findings file and retry;
  omit an unsupported claim explicitly rather than relying on the script to discard it.
- On a resumed session, analyze from `firstNewTurnIndex` onward. If a friction arc began earlier,
  cite the new turns that show it and summarize the earlier setup in prose — do not cite turns
  below `firstNewTurnIndex`.
- Treat parent and child transcripts as one task lineage when clustering repeated asks.
  `rawUserMessages` is empty for subagent and automation transcripts because their user-role prompt
  is machine-authored delegation, not a repeated human ask.
- Analyze `rawUserMessages` for repeated asks independently of friction. A recurring request about
  code shape, design, quality, or working method remains eligible when the agent complied without a
  blocker or failure. Call out likely standards candidates in the cluster body. Repeated product
  features are not standards candidates merely because they recur.
- Found nothing? Write the file with empty arrays. Do not invent friction to fill it.
