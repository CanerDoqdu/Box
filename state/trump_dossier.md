## Executive Strategic Dossier — `CanerDoqdu/markus-ruhl-23`

This repo is a Next.js App Router marketing site with a single sensitive backend surface (`app/api/contact/route.ts`) and high-visual frontend complexity (motion + 3D + shader pipeline). The architecture is cleanly segmented (`app`, `components`, `lib`, `types`), but the risk profile is asymmetric: one API endpoint can break trust/security, while shader/build fragility can break deploys and UX.

The most important finding is a **state mismatch** between commit history and snapshot content. Recent commits claim Redis sliding-window limiter and CSRF/CORS hardening were merged, but the provided `app/api/contact/route.ts` still shows an **in-memory limiter** (“Replace with Redis for multi-instance setups”). That is either (a) stale snapshot capture, or (b) partial merge/regression. This must be resolved first because it invalidates previous “fixed” conclusions.

No open issues/PRs is good for operational cleanliness, but with recent high-velocity security/backend merges, it more likely indicates backlog reset than true production certainty. The next phase must re-baseline with evidence before adding frontend tests/E2E/motion regression.

---

## Architecture Reading and What It Implies

The structure signals a modern, mostly disciplined codebase:

- Frontend pages under `app/(site)/*` and reusable UI in `components/*`.
- API contracts abstracted in `lib/api/response.ts` and `lib/api/validation.ts` (good consistency pattern).
- Dedicated mail and rate-limit modules (`lib/contact/mail.ts`, `lib/rate-limit.ts`) indicate intent to separate policy from route handlers.
- Shader support wired in `next.config.js` (`asset/source`) and typed declarations in `types/shaders.d.ts`, `types/shaders/index.d.ts`.

However, current production risk clusters around three boundaries:

1. **API reliability boundary**: contact route validation/rate-limiting/CORS/mail failure handling.
2. **Build/runtime asset boundary**: shader imports and WebGL assets (`.glsl/.vert/.frag`, GLB).
3. **Verification boundary**: tests exist (`app/api/contact/route.test.ts`, `lib/rate-limit.test.ts`) but broader frontend regression and E2E are still a gap.

Also important: `tsconfig.json` excludes test files from type-checking (`**/*.test.ts[x]`), which reduces confidence in test correctness drift.

---

## Reality Check vs Recent Merges (Critical)

### 1) Redis rate limiter claim vs route implementation
- Evidence: recent commits `813c1ea8`, `4a4f3666`, `750c6570` claim Redis sliding-window limiter work.
- Counter-evidence: snapshot `app/api/contact/route.ts` shows in-memory Map limiter comment and logic.
- Interpretation: **insufficient context provided** to confirm whether route currently imports `lib/rate-limit.ts` or retained fallback only. Requires immediate full-file verification.

### 2) CSRF/CORS hardening
- Evidence: commits `2fb5698e`, `3ac75a55`, `45312dee`; tests mention OPTIONS/POST and CORS checks in `app/api/contact/route.test.ts`.
- Risk: test appears to include source-regex assertions (from snapshot snippet), which can become brittle and pass without behavioral guarantees if wording changes.
- Need: ensure behavioral assertions dominate over static source heuristics.

### 3) Mail failure-path resilience
- Evidence: commits `af1b4836`, `76557079`, `48ccedde`, `818f3de3`, `067f9481`; closed issues #60/#61/#62/#63.
- Positive: repeated focus indicates reliability investment.
- Remaining risk: without complete current route/mail module context, cannot prove all failure classes map to stable HTTP and response envelope.

---

## Production Readiness Coverage (Explicit Domain Classification)

- **Backend correctness**: **Missing and required**.  
  Evidence: route snapshot still in-memory rate limiter despite Redis merge claims (`app/api/contact/route.ts`, commits above).

- **API contract consistency**: **Already adequate (pattern), but needs revalidation**.  
  Evidence: standardized helper layer in `lib/api/response.ts`; route adherence must be reconfirmed.

- **Input validation / abuse controls**: **Partially adequate, still missing proof**.  
  Evidence: `lib/api/validation.ts`, contact tests; mismatch on limiter implementation.

- **Auth/session management**: **Not applicable for current architecture**.  
  Evidence: marketing site with contact endpoint; no user accounts/session files in snapshot.

- **Token rotation / secret lifecycle**: **Missing and required (operationally)**.  
  Evidence: env-based mail/redis implied (`.env.example`, `.env.local.example` present), but no runbook/policy evidence provided.

- **Platform security headers / CORS / CSRF**: **Partially adequate, verification required**.  
  Evidence: security commits and tests exist; must confirm live route behavior.

- **Observability (logs, metrics, tracing, alertability)**: **Missing and required**.  
  Evidence: no telemetry modules/workflows surfaced in snapshot.

- **Anomaly detection / abuse monitoring**: **Missing and required**.  
  Evidence: no signals for threshold alerting on contact abuse.

- **Frontend UX/accessibility**: **Partially adequate**.  
  Evidence: closed issue #55 suggests hardening done; no broad frontend test suite evidence provided.

- **Motion safety / reduced-motion regression controls**: **Missing and required for next phase**.  
  Evidence: heavy motion components (`components/motion/*`) with no stated regression harness.

- **Performance budgets**: **Missing and required**.  
  Evidence: no explicit budget artifacts/config in snapshot.

- **SEO/indexability**: **Already adequate baseline**.  
  Evidence: `app/robots.ts`, `app/sitemap.ts`, App Router layout/pages.  
  Caveat: metadata completeness **insufficient context provided**.

- **Deployment safety / rollback strategy**: **Missing and required**.  
  Evidence: CI exists (`.github/workflows/ci.yml`) but no rollout/rollback workflow evidence.

- **CI/CD health**: **Adequate baseline, improvement required**.  
  Evidence: install/lint/build/type-check/test/audit pipeline exists; audit appears critical-only gate.

---

## Dependency Ordering and Execution Logic

Critical path is: **ground-truth scan → backend/security reconciliation → test expansion + CI gating → final QA baseline**.

You should not start frontend/E2E broadening before the API/security baseline is proven, because test matrix design depends on final behavior contracts and headers.

Parallelism should be limited to truly independent tracks:
- Shader/build fragility analysis can run in parallel with backend reconciliation.
- E2E/motion tests should wait until both backend and frontend contracts stabilize.

---

## Worker Activation Strategy (Minimum Safe Count)

Use **6 workers** total; this is the minimum safe count that preserves role purity and avoids rework loops:

1. `Issachar` (scan) — single source of truth scan packet.
2. `Aaron` (api) — contact route + limiter + mail-path implementation consistency.
3. `Elijah` (security) — hardening verification and abuse model.
4. `Esther` (frontend) — shader import fragility + motion-safe testability hooks.
5. `Samuel` (test) — integration + E2E + regression coverage.
6. `Noah` (devops) — CI wiring for new checks and rollback safety gates.

`Isaiah` QA can be skipped initially to reduce request burn; Samuel + Noah can provide sufficient acceptance artifacts if packets are strict.

---

## Phased Execution Plan (Large Coherent Packets)

### Wave 1 — Ground-Truth Re-baseline (Prerequisite Wave)
**Worker: Issachar (scan)**  
**Goal:** produce definitive code-state map against merged commits and closed issues.  
**Packet includes:**
- Verify contact route currently used limiter path (`app/api/contact/route.ts`, `lib/rate-limit.ts`, imports/call graph).
- Validate CSRF/CORS behavior actually implemented (OPTIONS handling, origin policy, credentials policy, allowed methods/headers).
- Confirm mail failure mapping in `lib/contact/mail.ts` + route boundary.
- Audit shader usage/import paths across components and any `.glsl/.vert/.frag` references.
- Enumerate test coverage by critical path (contact API, rate limiter, motion components, shader runtime paths).
- Identify outdated README claims versus implemented behavior (`README.md`).
**Verification output:** evidence log with file anchors and diff-ready recommendations.  
**Handoff contract:** downstream workers treat this as authoritative baseline.

---

### Wave 2 — Core Remediation and Stability
**Workers: Aaron (api), Esther (frontend), Elijah (security)**  
**Depends on:** Wave 1 report.

#### Aaron Packet (API owner)
- Reconcile rate limiter implementation with intended Redis sliding-window design.
- Ensure deterministic fallback behavior if Redis unavailable (must be explicit and observable).
- Harden contact route error taxonomy to always use `lib/api/response.ts` envelopes.
- Confirm `OPTIONS` + CORS header behavior and no unsafe GET handler.
- Verify try/catch boundaries include mail call site and map transport timeout/DNS/network failures deterministically.
**Evidence anchors:** `app/api/contact/route.ts`, `lib/rate-limit.ts`, `lib/contact/mail.ts`, `app/api/contact/route.test.ts`, commits #58/#57/#59/#60-#63 lineage.
**Downstream handoff:** stable API contract + headers + failure semantics for test authoring.

#### Esther Packet (Frontend owner)
- Resolve shader import fragility with a permanent, typed strategy.
- Validate `next.config.js` shader loader and declaration alignment in `types/shaders*.d.ts`.
- Add minimal runtime guardrails where shader assets may fail (without masking failures silently).
- Prepare motion components for deterministic testing hooks (`components/motion/*`, high-motion sections).
**Alternative paths to evaluate:**
- Path A (preferred permanent): keep `asset/source`, tighten import conventions + type declarations + smoke tests.
- Path B (temporary): fallback static material/visual path when shader import fails, with explicit logging.
**Impact analysis:**  
Path A lower correctness risk, moderate scope, clean rollback (single config revert).  
Path B lower immediate breakage risk but can hide visual regressions; acceptable only temporary.

#### Elijah Packet (Security owner)
- Re-audit CORS/CSRF assumptions against actual route behavior and test intent.
- Check for overly broad trust boundaries (e.g., permissive origin handling).
- Validate no secret leakage in error responses/logs.
- Review `next.config.js` remote image policy (`hostname: '**'`) for abuse surface.
**Downstream handoff:** signed security assertions and required policy edits.

---

### Wave 3 — Verification Expansion and CI Enforcement
**Workers: Samuel (test), Noah (devops)**  
**Depends on:** Wave 2 completion.

#### Samuel Packet (Test owner)
- Replace brittle source-regex assertions with behavior-first tests where possible (`app/api/contact/route.test.ts`).
- Expand negative-path coverage for contact endpoint: malformed content type, origin mismatch, rate-limit breach, mail timeout/DNS failure.
- Add frontend regression tests for motion-safe behavior and critical render guards.
- Introduce E2E happy path + failure path for contact flow (if Playwright setup exists; otherwise mark **insufficient context provided** and scaffold minimally).
**Handoff contract:** reproducible confidence suite that protects recently fixed areas from regression.

#### Noah Packet (DevOps owner)
- Integrate new tests into `.github/workflows/ci.yml` without exploding runtime.
- Preserve existing order (lint/build/type-check/test/audit) while adding E2E stage with sane gating.
- Add rollback-safety checks/documented release guardrails (e.g., fail-fast rules, artifact retention policy).
- Revisit audit threshold strategy (critical-only may be too weak for internet-facing form endpoint).
**Handoff contract:** CI becomes enforceable protection layer, not advisory.

---

## Evidence-Mapped Top Priorities

1. **Reconcile route implementation with Redis-limiter security claims**  
   Anchors: `app/api/contact/route.ts`, `lib/rate-limit.ts`, commits `813c1ea8`, `4a4f3666`, issue #58.

2. **Revalidate CSRF/CORS hardening behaviorally (not textually)**  
   Anchors: `app/api/contact/route.test.ts`, commits `2fb5698e`, `3ac75a55`, `45312dee`, issue #59.

3. **Stabilize shader import pipeline and testing hooks**  
   Anchors: `next.config.js`, `types/shaders.d.ts`, `types/shaders/index.d.ts`, 3D components under `components/sections/home/*`.

4. **Close production-readiness blind spots (observability, rollback, anomaly detection)**  
   Anchors: absence in provided files; CI only in `.github/workflows/ci.yml`.

---

## Premium Request Budget (Conservative)

Estimated total: **56 premium requests**.

### By wave
- **Wave 1:** 10  
  One deep scan activation, one consolidated evidence report, likely one correction pass.
- **Wave 2:** 24  
  Three workers with implementation + self-validation + one retry risk each.
- **Wave 3:** 22  
  Test and CI work typically incurs higher retry due flaky assumptions and pipeline wiring.

### By role
- **Issachar (scan): 10**  
  Comprehensive baseline report and evidence mapping.
- **Aaron (api): 12**  
  Core backend correctness with regression-sensitive changes.
- **Elijah (security): 8**  
  Focused hardening review and policy corrections.
- **Esther (frontend): 10**  
  Shader/motion stabilization plus testability prep.
- **Samuel (test): 10**  
  Behavioral test expansion and E2E pathing.
- **Noah (devops): 6**  
  CI integration and gating refinements.

Why this is efficient: few workers, large coherent packets, strict wave dependencies, and no same-cycle follow-ups reduce churn and repeated context loading.

---

## Final Recommendation to Moses

Run this as a **dependency-disciplined 3-wave campaign** with **6 total workers**. Do not skip Wave 1 re-baseline; current evidence shows likely drift between commit narrative and live code state. Prioritize backend/security truth first, then frontend shader stability, then test/CI enforcement. That sequence gives the cleanest foundation for your next phase (frontend tests, E2E, motion regression) with the lowest rework risk and controlled premium-request burn.
