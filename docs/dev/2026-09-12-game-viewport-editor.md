# Fixed viewport editor experience

## Changes

- Reduced the top-level navigation to the two player-facing scenes: 推演台 and 演武场.
- Embedded blueprint editing inside 推演台 as a mode switch, with the selected spell loaded from the shared spellbook.
- Made the lab and arena fixed viewport workspaces. The document itself does not scroll; compact panels and mobile selectors keep the active workflow in view.
- Replaced the full-book textarea with a selected-spell editor that provides line numbers, token highlighting, and a small language guide.
- Added AST-to-blueprint hydration and blueprint-to-shared-spellbook writeback, preserving entry parameters and enabling immediate arena use.
- Added distinct visual treatments for flow pins, value pins, body pins, entry nodes, expression nodes, and statement nodes.
- Updated rendering and Playwright smoke coverage for the embedded blueprint workflow.

## Verification

- `npm run typecheck`
- `npm run lint`
- `npm run test` (26 tests)
- `npm run test:e2e` (6 tests)
- Playwright viewport checks at 1440x900 and 390x844: document scroll size equals viewport size.
