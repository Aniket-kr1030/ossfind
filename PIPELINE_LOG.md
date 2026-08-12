# Pipeline Quality Gate Battery Log

| Gate ID | Name | Spawned By (Defect/Decision) |
|---|---|---|
| G1 | Contract validation | Decision to guarantee that every pipeline output conforms to Zod schemas (preventing malformed objects). |
| G2 | Determinism check | Decision to ensure repeatable and consistent ranking outputs across multiple identical runs. |
| G3 | Critical CVSS safety fact | Audit F2/F3: active critical vulnerabilities (including future fixes) and CVSS v3.0/v3.1/v4 source vectors must never yield `ship`. |
| G4 | SPDX license safety fact | Audit F1: prove across GPL/AGPL case, suffix, parentheses, AND/OR expression variants and unknown/null licenses that permissive projects never receive `ship`. |
| G5 | Offline isolation | Decision to run the entire pipeline offline and guarantee zero unexpected network/fetch calls are made. |
| G6 | Version-relevance safety fact | Audit F5: prerelease, multi-interval, `last_affected`, explicit-version, and unparseable-version OSV relevance must be fail-closed. |
| G7 | Evidence completeness | Audit F4: prove the maximum permitted verdict for OSV, license, and scorecard source states; failed/missing OSV or license blocks `ship`. |
