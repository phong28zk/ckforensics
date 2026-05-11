# Pre-Commit Audit Workflow

Pattern: before user runs `git commit`, generate a manifest of what Claude touched and use it as commit/PR body draft.

## Flow

```
1. ckforensics ingest                       # ensure DB current
2. ckforensics audit --last --out review.md # capture this session's manifest
3. ckforensics redact review.md --in-place  # strip secrets before sharing
4. (user opens review.md, copies relevant sections to commit body)
```

## When Claude runs this skill

User says one of:
- "ready to commit"
- "draft a commit message from this session"
- "what should the PR description say"
- "review what I just did before committing"

## What Claude should do

1. Run `audit --last` to get the manifest.
2. Pipe through `redact` (always, never skip — secrets risk).
3. Extract from manifest:
   - **Files changed** + line counts (for `git diff --stat` equivalent)
   - **Reasoning quotes** per file (often makes the PR body)
   - **Subagent contributions** (mention if subagents did significant work)
4. **Draft conventional commit**:
   ```
   <type>(<scope>): <subject>
   
   <body — TLDR of what changed and why, from reasoning>
   
   <body — files affected, key decisions>
   ```
5. **Surface anything suspicious:**
   - Files touched in unexpected directories
   - Reasoning that doesn't match the actions (intent drift)
   - Subagents with high cost (worth mentioning in PR)

## Integration with ck:git

After draft, hand off to `/ck:git cm` for execution:
```
ckforensics audit --last --out review.md
ckforensics redact review.md --in-place
# Claude reads review.md, drafts commit message
# Hand to /ck:git cm — user reviews + executes
```

Or pipe directly (v0.5 phase 12 will support this):
```
ckforensics commit --phase last | ck:git cm --message-stdin
```

## Anti-patterns

- ❌ Skip redaction — manifests can contain edited file contents = secrets risk
- ❌ Paste raw manifest as commit body (too long, unstructured)
- ❌ Auto-commit — always show draft, let user approve via /ck:git
- ❌ Forget to mention subagents — they did work that deserves credit/audit
