# Arena and lab workflow closure

- The lab owns the single spell DSL source and handles writing plus one-shot testing; the arena handles base attributes, bindings, and combat only.
- The arena now has setup, start, pause/resume, and restart states; pausing freezes the battle loop for inspection and tuning.
- The spell source is shared at the application layer, and the arena no longer provides a spell source editor.
- Arena attributes and bindings are application-owned, so they survive switching to the lab, editing a spell, and returning to the arena.
- The E2E suite covers setup, start, pause, lab editing, and returning to the arena.
