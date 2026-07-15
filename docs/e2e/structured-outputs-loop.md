# Structured outputs — loop-until-clean validation

This file was created by the second structured-outputs e2e chain (see
docs/plans/structured-workflow-outputs.md, which this repository contains).
Its chain ran strategy loop-until-clean with a declared `--until verdict=CLEAN`
predicate: the loop stop decision was made from the review's machine-validated
structured verdict, not from a ===REVIEW=== marker.
