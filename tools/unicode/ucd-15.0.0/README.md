# Vendored UCD 15.0.0 data (D-74, D-77, M1-21-b)

`DerivedGeneralCategory.txt` is the Unicode Character Database 15.0.0 file
`extracted/DerivedGeneralCategory.txt`, copied byte for byte (header: `DerivedGeneralCategory-15.0.0.txt`,
`Date: 2022-04-26, 23:14:35 GMT`). It is data only: nothing executes it.

- **Source:** <https://www.unicode.org/Public/15.0.0/ucd/extracted/DerivedGeneralCategory.txt>
- **SHA-256:** `fe29a45c0882500e591140aaa5c4f5067e6a5d746806148af34400c48b9c06f9`, pinned in
  `SHA256SUMS` here and in `tools/unicode/generate_ucd15_table.py` (04 §3.4 "Table provenance").
- **Verified on 2026-10-15** by three byte-identical copies: `www.unicode.org/Public/15.0.0/ucd/extracted/`,
  `unicode.org/Public/15.0.0/ucd/extracted/`, and the file inside `UCD.zip` of Debian's
  `unicode-data_15.0.0.orig.tar.bz2` (the tarball matches the SHA-256 in Debian's
  `unicode-data_15.0.0-1.dsc`), which is the same `UCD.zip` as
  <https://www.unicode.org/Public/zipped/15.0.0/UCD.zip>. Before vendoring, the table generated
  from it was compared with the interim CPython 3.12 `unicodedata` table (D-77): no code point differs.
- **Licence:** Unicode License V3, in `LICENSE.txt` (the file's header points to
  <https://www.unicode.org/terms_of_use.html>).

`tools/unicode/generate_ucd15_table.py` reads only this file, refuses it unless its SHA-256 is the
pinned one, and writes `packages/types/src/ucd15.ts`. `tools/unicode/check-ucd15.mjs` (part of
`pnpm lint`) fails on any difference. Never edit the file; moving to another Unicode version is a
spec change (04 §3.4).
