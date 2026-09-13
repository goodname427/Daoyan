# Blueprint connections

- Fixed input handles to keep stable IDs such as `in0` and `in1` while showing parameter names separately.
- Allowed the spell entry node to be a valid flow source, while keeping ordinary statement nodes as flow targets.
- Added a Playwright regression that drags the entry flow output to a statement flow input and verifies the edge remains after pointer release.
