# Observatory simulation archive — 12 October 2026

The old simulation worlds were stopped by Danielius for The Night Shift rebuild. This archive preserves the actual public simulation evidence before replacement.

- Source: https://autonomous-observatory-20261011.xndanius.chatgpt.site
- Final immutable publication: revision 128, updated 2026-10-12T11:35:48.429Z, paused.
- Retrieval: 2026-10-12T11:39:16.710Z to 2026-10-12T11:39:50.399Z (actual UTC timestamps).
- 17 worlds, 530 contiguous events, 128 complete historical publications, and 130 original cloud decision/usage/status receipts.
- 15577818 stored evidence bytes; manifest SHA-256: 8a6192ed3173391fd3cc3a6481b51f4cbe57310fe5d6f2ef333b58464b05f8b7.

`final-index.json` is the exact final compact public response. `worlds/` contains exact final world responses pinned to revision 128. `events/` contains gzip JSON with all actual events and snapshots for each world. `revisions/` contains gzip-compressed exact full public responses for every revision 1–128, including the final paused state. `receipts/` preserves the original tracked JSON bytes. The active shared budget ledger and clock remain under `data/`.

Every world’s canonical SHA-256 was matched to its final index reference. Event turns were checked for contiguous 1..turn coverage; their retained tail exactly matches the final world timeline, and the final event timestamp matches the world update timestamp. The final expanded historical state was compared to the final compact pointer, and the public pointer was re-read to establish that it remained stable while archiving. No events, timestamps, activity, tokens or costs were invented.

`manifest.json` records file sizes and SHA-256 digests, per-world counts, historical revision times/counts, and actual retrieval provenance. Use `gzip -cd` to read compressed JSON. Git retains the original source history; the old server-side object store was not deleted by this archiving process.
