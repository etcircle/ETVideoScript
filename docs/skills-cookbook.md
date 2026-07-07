# Skills cookbook

## assemble-from-clips

### What it does

`assemble-from-clips` is a compact worked example of a multi-clip reference skill. It connects to the agent WebSocket, reads the merged transcript through the protocol, reads the local v2 manifest to discover `tracks[0].clips[]`, proposes a narrative clip order, and emits clip-aware tightening cuts. The important bit is that every edit proposal carries the `clipId` from the transcript/manifest, so a cut in `clip_002` stays clip-local even if the output timeline order changes later.

### How it works

The skill follows the same shape as the older reference skills: parse CLI args, open the WebSocket with the project token, send `hello`, call `get_transcript`, then emit edits via protocol tool calls. It reads `edits/manifest.json` only to inspect the current clip order and source ranges; edits still flow through `propose_cut`, preserving the manifest-as-contract rule. After proposing cuts it calls `get_render_state` and prints a JSON summary containing `proposedOrder`, `cutsEmitted`, and `manifestStateAfter`.

### Heuristics used

For ordering, the first roughly 30 words classify clips with greeting/opening phrases as `intro`, sign-off phrases as `outro`, and everything else as `body`. Body clips keep upload order. For tightening, the first word and last word in each clip define likely dead-air regions; the skill trims up to about 0.5 seconds at the head and tail where timing allows.

### Adapting for your use case

Replace the phrase heuristics with your own story logic: chapter titles, speaker names, screen-recording actions, or a user-supplied `--narrative-hint`. Keep the same discipline: read transcript words with `clipId`, emit clip-local ops only, and avoid hidden mutations. Today the protocol has no clip-reorder primitive, so changed order proposals should be logged or performed outside the skill once a deterministic clip-reorder CLI/API exists.

## compose-from-takes

### What it does

`compose-from-takes` is the reference skill for the multi-take pipeline: turning several raw takes of the same script into one composed timeline. Invoke it with `ets skill compose-from-takes --ws-url ws://127.0.0.1:4317/ws/projects/<id>/agent/<session> --token <token> --workspace <ws> --project-id <id> --group main`.

### How it works

It connects to the agent WebSocket, calls `brief_show` (bailing out with a clear message if `brief.md` hasn't been created yet - composition decisions must be grounded in the brief), then `takes_align` to build `takes/alignment.json` from every transcribed take in the group. For each span in the alignment it picks the candidate with the highest composite score (`matchQuality - 0.05*fillerCount - 0.05*falseStartCount`) and builds a composition selecting that take's delivery of the span, in reference order. It applies the result via `compose_apply`, which validates the composition and materializes it into the timeline track (or throws with the specific rule violations if it doesn't validate).

### Adapting for your use case

The composite-score heuristic is a deterministic starting point, not the final word - an agent should read `takes/alignment.json` (or call `takes_spans` / `takes_span_detail`) and override individual span choices based on the brief: preferring a take with better delivery even at a small filler-count cost, picking up an orphan aside as a bonus insert, or leaving a span as a gap for a `voice_patch`. Every selection in the composition file carries a `rationale` field - always fill it in with the actual reason a human or agent would want to know, not a restatement of the rule.

## Multi-clip skill patterns

### Derive `clipId` from transcript words

Treat transcript words as the safest edit target. In v2 merged transcripts, every word should carry `clipId`; group candidate edits by that field before calculating cut/mute ranges. If a word is missing `clipId`, fail loudly or recover from the per-clip transcript source path only when the mapping is unambiguous.

### Emit clip-aware operations

Every operation proposed against a v2 manifest needs the target `clipId` plus clip-local `start`/`end` times. Do not convert to output time inside the skill; render/time-map code derives output-time placement from `tracks[].clips[]` and approved cuts.

### Validate before exit

After emitting proposals or approved operations, call the protocol render/manifest state tool or run `ets validate-manifest` from the workspace. A multi-clip skill should exit non-zero if it leaves the manifest invalid, because bad clip ids and overlapping clip-local cuts are much cheaper to fix before render.
