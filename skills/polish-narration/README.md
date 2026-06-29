# polish-narration

Use `--range start,end` to read selected transcript words.
Proposes one `voice_patch` using `provider=mock` and uppercased source text.
Works on multi-clip projects — each emitted op is scoped to the clip its target word belongs to.
No paid provider is called; exits after the proposal.
