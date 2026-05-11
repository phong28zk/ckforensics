# Claude Code JSONL Schema — v1

Reverse-engineered from live session files in `~/.claude/projects/**/*.jsonl`.
One JSON object per line, UTF-8, append-only. Schema is schema-v1 per `schema-detector.ts`.

---

## Common Envelope Fields

Present on most rows (not on `file-history-snapshot`, `last-prompt`, `permission-mode`):

| Field | Type | Notes |
|-------|------|-------|
| `type` | string | Discriminator — see event types below |
| `uuid` | string (UUID v4) | Unique ID for this row |
| `parentUuid` | string \| null | Links to previous turn in conversation tree |
| `sessionId` | string (UUID v4) | Groups all rows of one session |
| `timestamp` | ISO 8601 string | Wall clock time of event |
| `cwd` | string | Working directory at time of event |
| `version` | string | CC client version, e.g. `"1.0.0"` |
| `gitBranch` | string | Active git branch |
| `isSidechain` | boolean | True for tool-result plumbing turns |
| `userType` | string | `"external"` or `"internal"` |
| `entrypoint` | string | How session was started, e.g. `"cli"` |

---

## Event Types

### `assistant`

LLM response turn.

```json
{
  "type": "assistant",
  "uuid": "…",
  "requestId": "req_01XyzAbc…",
  "message": {
    "id": "msg_01…",
    "role": "assistant",
    "model": "claude-opus-4-5",
    "content": [ /* content blocks */ ],
    "stop_reason": "end_turn",
    "usage": {
      "input_tokens": 3,
      "output_tokens": 39,
      "cache_creation_input_tokens": 24127,
      "cache_read_input_tokens": 18212,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 24127
      },
      "service_tier": "standard"
    }
  }
}
```

**Content blocks** (`message.content[]`):

| `type` | Key fields | Notes |
|--------|-----------|-------|
| `text` | `text: string` | Plain text response |
| `thinking` | `thinking: string` | Extended thinking scratchpad |
| `tool_use` | `id`, `name`, `input` | Tool invocation; `input` is tool-specific JSON |

Common tool names: `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `Task`, `TodoWrite`, `WebFetch`.

**Token fields** (`message.usage`):

| Field | Type | Description |
|-------|------|-------------|
| `input_tokens` | int | Non-cached input tokens billed |
| `output_tokens` | int | Output tokens generated |
| `cache_creation_input_tokens` | int | Tokens written to prompt cache |
| `cache_read_input_tokens` | int | Tokens served from prompt cache |
| `cache_creation` | object | Breakdown by cache tier (`ephemeral_5m`, `ephemeral_1h`) |

---

### `user`

Human turn or tool result being fed back to the model.

```json
{
  "type": "user",
  "uuid": "…",
  "isMeta": false,
  "toolUseResult": null,
  "sourceToolAssistantUUID": null,
  "message": {
    "role": "user",
    "content": "string | content[]"
  }
}
```

When `isMeta: true` the row is an internal tool-result plumbing message (not a human prompt).

**Content** can be:
- Plain `string` — literal user message
- Array of blocks including `tool_result`:

```json
{ "type": "tool_result", "tool_use_id": "toolu_…", "content": "string | [{type,text}]" }
```

---

### `system`

Lifecycle events from hooks, stop reasons, local commands.

| `subtype` | Meaning |
|-----------|---------|
| `stop_hook_summary` | Post-turn hook results; includes `hookCount`, `hookInfos`, `hookErrors`, `preventedContinuation`, `stopReason` |
| `local_command` | Output from a shell command run locally |
| *(absent)* | Generic system message |

Key fields: `subtype`, `level` (`"info"` / `"warning"`), `content`, `toolUseID`, `stopReason`.

---

### `file-history-snapshot`

Snapshot of file state at a conversation checkpoint. Content may be large.

```json
{ "type": "file-history-snapshot", "messageId": "…", "isSnapshotUpdate": false, "snapshot": { … } }
```

---

### `attachment`

File or image attached to the conversation.

```json
{ "type": "attachment", "uuid": "…", "attachment": { … } }
```

---

### `queue-operation`

Task queue markers for async tool orchestration.

```json
{ "type": "queue-operation", "operation": "enqueue" | "dequeue", "sessionId": "…", "content": { … } }
```

---

### `permission-mode`

Permission level change during session.

```json
{ "type": "permission-mode", "permissionMode": "bypassPermissions" | null, "sessionId": "…" }
```

---

### `last-prompt`

Persisted at end of session with the final user prompt text.

```json
{ "type": "last-prompt", "lastPrompt": "…", "sessionId": "…" }
```

---

### `progress`

Real-time progress events from hooks or subagents during tool execution.

```json
{
  "type": "progress",
  "uuid": "…",
  "toolUseID": "toolu_…",
  "parentToolUseID": "toolu_…",
  "agentId": "agent-abc123",
  "slug": "my-session-slug",
  "data": { "type": "hook_progress", "hookEvent": "PreToolUse", "hookName": "…", "command": "…" }
}
```

---

## Version Detection Heuristics (schema-detector.ts)

A file is classified as **v1** when peeking the first 10 lines finds:
- At least one row with `type` in `{assistant, user, system, file-history-snapshot, progress}`
- At least one row with a `version` string field **or** a UUID `uuid` field

Files that fail both conditions → `"unknown"` (handled by UnknownEvent bucket).

---

## Token Sum Formula

```
totalInput   = Σ message.usage.input_tokens
totalOutput  = Σ message.usage.output_tokens
totalCacheW  = Σ message.usage.cache_creation_input_tokens
totalCacheR  = Σ message.usage.cache_read_input_tokens
```

Cross-validate with jq:
```sh
jq -s '[.[] | select(.type=="assistant") | .message.usage // empty |
  {i:.input_tokens, o:.output_tokens,
   cw:(.cache_creation_input_tokens//0), cr:(.cache_read_input_tokens//0)}] |
  {input:(map(.i)|add//0), output:(map(.o)|add//0),
   cache_write:(map(.cw)|add//0), cache_read:(map(.cr)|add//0)}' session.jsonl
```
