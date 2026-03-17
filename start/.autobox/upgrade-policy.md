# AutoBox Upgrade Policy

Generated: 2026-03-10T17:23:14.462Z
Project: start
Purpose: General software product with mixed capabilities
Complexity Ceiling: low (2.88)

Rules:
1. Do not rewrite architecture unless required by breakage.
2. Prefer patch/minor upgrades first, then limited major upgrades.
3. After each upgrade slice: lint -> typecheck -> test -> build.
4. Stop on first regression and document rollback.

Safe candidates (0):

Major candidates (selected up to 2):
