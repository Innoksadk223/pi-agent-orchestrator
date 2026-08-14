# agent_team Plan Template

Use as the compact input checklist for one `agent_team {action:"plan"}` USER_GATE. TeamState is authoritative; `leader/plan.md` is generated as a recovery view.

```json
{
  "action": "plan",
  "team": "<team-id>",
  "plan": {
    "members": [
      {
        "id": "coder",
        "kind": "coder",
        "role": "Coder/Executor",
        "instructions": "Write only the owned paths in the TaskPacket. End with the execution JSON envelope."
      },
      {
        "id": "reviewer",
        "kind": "reviewer",
        "role": "Independent Reviewer",
        "instructions": "Read-only. Decide VERIFIED or FIX_REQUIRED only through a ReviewRound envelope.",
        "tools": ["read", "grep", "find", "ls"]
      }
    ],
    "reviewerId": "reviewer",
    "tasks": [
      {
        "id": "implementation",
        "memberId": "coder",
        "objective": "<observable result>",
        "constraints": ["<scope or prohibition>"],
        "dependsOn": [],
        "ownedPaths": ["src/concrete-path"],
        "acceptance": ["<binary condition>"],
        "relevantPaths": ["src/concrete-path/index.ts"]
      }
    ],
    "acceptance": ["FINAL_VERIFY evidence is complete", "User performs HUMAN_ACCEPT"]
  }
}
```

For amendment, resend the complete plan and add:

```json
{"expectedRevision": 1}
```

Checks before calling:

- IDs are unique; reviewerId names a `reviewer`; every ExecutionTask owner is a `coder`.
- DAG dependencies exist and are acyclic.
- ownedPaths are concrete cwd-relative paths, never absolute, `..`, or globs.
- Unordered tasks have no equal or parent/child owned-path conflicts.
- Roster, TaskPackets, ownership, and acceptance are complete enough that later rounds need only IDs and deltas.
- Optional debugger/product/optimizer members are pre-approved now or added later through amendment.
- Do not include full global prose, secrets, member chat instructions, or historical outputs.
