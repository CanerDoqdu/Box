# AutoBox Runtime Instructions

Generated: 2026-03-10T17:23:14.464Z
Objective: Deliver production-safe improvements with minimal regressions.

Mandatory checks:
- Keep implementation deterministic where possible.
- Preserve backward compatibility unless explicitly breaking by design.
- Every missing dependency must map to a placeholder artifact.

Priority Order:
1. reliability
2. security
3. performance
4. architecture
