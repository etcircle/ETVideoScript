# find-fillers

Scans the full transcript for simple filler words: um, uh, like, y'know.
Proposes one `mute` operation per match through the agent WebSocket.
Works on multi-clip projects — each emitted op is scoped to the clip its target word belongs to.
Run via `ets skill find-fillers --ws-url ... --token ... --project-id ...`.
Exits after all proposals are submitted.
