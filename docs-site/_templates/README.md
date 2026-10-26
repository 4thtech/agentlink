# Page templates

Skeletons for the page types in the [docs model](../../docs/process/docs-model.md). Copy one into a space, replace every `<…>`, delete the hints in HTML comments, and add the page to that space's `SUMMARY.md`.

| Template | Page type | Space |
|---|---|---|
| [`screen-guide.md`](screen-guide.md) | Screen guide (one local-app page) | `guide/local-app/` |
| [`how-to.md`](how-to.md) | How-to task | `guide/` |
| [`concept.md`](concept.md) | Concept for users | `guide/` |
| [`technical-concept.md`](technical-concept.md) | Technical concept | `technical/concepts/` |

This folder is not published. GitBook Git Sync reads only each space's project directory (`docs-site/guide`, `docs-site/technical`), so nothing here reaches GitBook. Worked example: [`guide/local-app/files.md`](../guide/local-app/files.md).
