# tighten-section

Use `--range start,end` to scan part of the transcript.
Finds the first repeated two-word phrase and proposes a `cut` for the second copy.
Works on multi-clip projects — each emitted op is scoped to the clip its target word belongs to.
Talks only through the agent WebSocket and exits after proposing.
