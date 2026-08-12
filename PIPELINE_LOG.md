# Pipeline Quality Gate Battery Log

| Gate ID | Name | Spawned By (Defect/Decision) |
|---|---|---|
| G1 | Contract validation | Decision to guarantee that every pipeline output conforms to Zod schemas (preventing malformed objects). |
| G2 | Determinism check | Decision to ensure repeatable and consistent ranking outputs across multiple identical runs. |
| G3 | Explainability + critical-CVE | Defect A (severity parsing misses CVSS-only advisories) and Decision to block shipping components with unfixed critical CVEs. |
| G4 | License compatibility | Decision to prevent GPL-3.0/incompatible components from being shipped in MIT/compatible projects. |
| G5 | Offline isolation | Decision to run the entire pipeline offline and guarantee zero unexpected network/fetch calls are made. |
| G6 | Resilience + version-relevance | Defect B (vulnerability count is version-agnostic) and Decision to degrade gracefully on 429/500/timeout adapter errors. |
