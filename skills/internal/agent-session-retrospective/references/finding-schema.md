# Finding envelope (subagent contract)

You are one per-repo subagent. You receive a **bundle JSON** for a single repo. Read it, find
friction, and write a **findings JSON** to the sibling path (same directory, filename with
`<repoHash>.json` → `<repoHash>.findings.json`).

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
      "threadSource": "user" | "subagent" | "automation" | "…" | null,
      "parentSessionId": "…" | null,
      "role": "primary" | "secondary",
      "firstNewTurnIndex": 0,        // analyze turns at this index and after
      "priorFindingCount": 0,
      "turns": [
        { "kind": "user" | "assistant", "ref": "t0", "text": "…" },
        { "kind": "tool_call", "ref": "t1", "name": "exec_command",
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
      "citedTurnRefs": ["t14", "t15"],// must exist in that session; invalid → dropped
      "body": "Free-form: what the agent attempted, the blocker it hit, how it pivoted, the outcome."
    }
  ],
  "durableFixProposals": [
    {
      "citedEpisodeRefs": ["e1"],     // must name episodes above; empty/invalid → dropped
      "body": "Target: <where the fix lands — code | tooling | setup | infra | deps | docs | agent-skill | AGENTS.md | CLAUDE.md | hook | preflight>\nConfidence: high | medium | low\n\nThe inferred root cause and the concrete durable fix."
    }
  ],
  "repeatedAsks": [
    {
      "label": "short cluster name",
      "exampleSessionIds": ["…"],
      "body": "The recurring ask (fix/revert/change the agent had to be told more than once) and what would stop it recurring."
    }
  ]
}
```

## Rules

- A **friction episode** is concrete: a real attempt → blocker → pivot, anchored to cited turns.
  Not "the agent could have been faster" — that cites nothing.
- Lead every `durableFixProposal.body` with `Target:` and `Confidence:` lines. The body is prose;
  there are no other required fields.
- **Rank the fix by value × recurrence, not by where it lands.** A code, tooling, or setup fix is
  first-class — e.g. "`mt spawn` doesn't install deps / generate clients, so the agent runs the
  same workaround every session" is a high-value proposal, not a footnote. Name the actual landing
  surface even when a transcript says the fix already landed; current-state resolution belongs to
  the later synthesis audit, not this per-repo finding.
- Cite only refs that exist in the bundle. The commit step drops episodes with bad turn refs and
  fixes with bad episode refs, so a hallucinated citation silently loses the whole finding.
  `repeatedAsks.exampleSessionIds` are also validated — unknown ids are stripped.
- On a resumed session, analyze from `firstNewTurnIndex` onward. If a friction arc began earlier,
  cite the new turns that show it and summarize the earlier setup in prose — do not cite turns
  below `firstNewTurnIndex`.
- Treat parent and child transcripts as one task lineage when clustering repeated asks.
  `rawUserMessages` is empty for subagent and automation transcripts because their user-role prompt
  is machine-authored delegation, not a repeated human ask.
- Found nothing? Write the file with empty arrays. Do not invent friction to fill it.
