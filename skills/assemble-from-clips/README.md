# assemble-from-clips

`assemble-from-clips` is a reference skill that shows an agent assembling a simple multi-clip story from raw clips. It reads the merged transcript, inspects the current video-track clip order, classifies each clip as intro/body/outro from transcript text, and emits clip-aware `cut` proposals that trim likely dead air at the head and tail of each clip.

## CLI

```bash
ets skill assemble-from-clips \
  --ws-url ws://127.0.0.1:4318/ws/projects/episode-001/agent/assemble-from-clips \
  --token "$ETVS_AGENT_TOKEN" \
  --workspace /path/to/workspace \
  --project-id episode-001 \
  --narrative-hint "open with the greeting, end with the sign-off"
```

Works on multi-clip projects — derives `clipId` on every emitted op from the merged transcript.

## Heuristics and limitations

The skill uses intentionally simple text heuristics: greetings such as “hello”, “welcome”, “today we”, or “in this video” are treated as intro clips; endings such as “thanks for watching”, “see you next”, “subscribe”, or “bye” are treated as outros; everything else stays body, preserving original order within body clips. Agent-protocol v3 exposes registry-driven `propose_operation` edit proposals, but this skill still logs and skips changed clip order rather than mutating track clip order. Reordering should go through a structural v3 tool such as `move_clip`/track operations in a follow-up skill.
