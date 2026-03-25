# Unified Master Plan (Tum Prometheus Taramalari Tek Dosyada)

Bu belge 2026-03-23 tarihli 4 ayri Prometheus taramasinin birlestirilmis ve tekillestirilmis halidir.

Tarama kaynaklari:
- S1: 08:27:04 cikisi — 5 task
- S2: 08:43:56 cikisi — 21 task
- S3: 09:41:10 cikisi — 28 task
- S4: 10:27:39 cikisi — zorunlu sorularin cevaplari + en detayli roadmap; parser bunu 51 plan diye kaydetti ama bunun bir kismi gercek task degil, teshis/politika/metrik satirlari da task diye sayildi

Bu dosyada tekrar eden maddeler tek bir kanonik maddeye indirildi. Her maddenin sonunda hangi taramalarda yer aldigi belirtilir.

---

## 1. Zorunlu Sorularin Net Cevabi (S4)

1. Wave modeli tek basina en verimli model degil.
Detay: Mevcut wave modeli guvenli ve izlenebilir; ancak BOX zaten `dependencyGraph` ve budget mekanikleri kullandigi icin saf wave yerine dependency-aware DAG + risk-gated wave hibriti daha verimli goruluyor.

2. Wave modeli kaldirilmamali, iyilestirilmeli.
Detay: Governance ve audit icin wave korunuyor; paralellik ve verim icin wave icerigi DAG mantigiyla uretiliyor.

3. Onerilen gecis modeli: Hybrid Orchestration.
Detay: `DAG scheduling + bounded waves + risk gates`.
Onerilen gecis sirasi:
- Once verification altyapisini duzelt
- Sonra DAG'i ana scheduler yap
- Sonra Athena gate'i DAG-aware yap
- Sonra rollout'u canary ile kademeli ac

Bu cevaplarin anlami:
- Prometheus "json formatini degistirelim" demiyor.
- Prometheus burada yurutme modelini tartisiyor: isler nasil siralansin, nasil paralellestirilsin, nasil gate'lensin.
- Yani konu veri formatindan cok orkestrasyon modeli.

---

## 2. Birlesik Teshis Ozeti

Tum taramalardan ortak cikan ana sorunlar:

1. En buyuk acil blokaj: Windows test harness problemi.
Detay: `node --test tests/**/*.test.js` Windows shell glob davranisi yuzunden yalanci fail uretiyor. Bu problem postmortemleri bozuyor, Athena gate guvenini bozuyor, ogrenme dongusunu kirletiyor.
Kaynak: S1, S2, S3, S4

2. `evolution-worker` asiri merkezilesmis durumda.
Detay: Sistem cok zengin analiz uretiyor ama execution tarafinda tek role yigiliyor. Bu da monoculture, serialization ve bottleneck olusturuyor.
Kaynak: S1, S3, S4

3. Planlama ve governance tarafi runtime gerceginden ayrisabiliyor.
Detay: Docs/runtime drift, stale task definitions, config/schema ambiguity ve lifecycle drift tekrar tekrar cikiyor.
Kaynak: S2, S3, S4

4. Ogrenme dongusu yeterince kapali degil.
Detay: Ayni dersler tekrar yaziliyor ama canonical defect kimligi, recurrence lifecycle ve closure evidence disiplini zayif.
Kaynak: S1, S2, S3, S4

5. Premium request kullanimi optimize degil.
Detay: Infra gurultusu ve belirsizlik tekrarlari request deger yogunlugunu dusuruyor.
Kaynak: S1, S2, S3, S4

6. Prometheus ayrintili dusunce uretebiliyor ama task cikarma katmani hala kusurlu.
Detay: Son taramada JSON tarafinda teshis, politika ve KPI satirlari bile task sayildi. Yani problem sadece modelde degil, parser/normalization katmaninda da var.
Kaynak: S4

---

## 3. Tekillestirilmis Kanonik Gorev Listesi

### A. Gate Blocker ve Verification Foundation

1. Windows verification harness fix
Ne yapilacak:
- Tum local/CI/runtime verification yuzeylerinde `node --test tests/**/*.test.js` benzeri shell-dependent kaliplari kaldir
- Yerine `npm test` veya deterministic explicit file enumeration kullan
- Bu komutun tek dogru entrypoint olmasini sagla
Neden:
- Yalanci FAIL uretip postmortemleri, learning loop'u ve Athena gate'lerini kirletiyor
Ek detaylar:
- S1 bu isi guard test ile birlikte istiyor
- S3 bunu runtime/scripts/docs dahil her operasyonel yerde temizle diyor
- S4 bunu tum 10 carry-forward maddesini tek hamlede kapatan ana blokaj olarak tanimliyor
Kaynak: S1, S2, S3, S4

2. Athena hard gate for harness fix
Ne yapilacak:
- Sonraki planlarda harness fix gorevi yoksa Athena plani otomatik reddetsin
- Bu kural merge + verified olana kadar aktif kalsin
Kaynak: S2, S3, S4

3. Verification command lint rule
Ne yapilacak:
- Shell'e bagli wildcard/glob komutlarini lint/gate seviyesinde reddet
- Deterministic expansion olmayan verification komutlarini kabul etme
Kaynak: S4

4. CI parity check for verification entrypoint
Ne yapilacak:
- Local ve CI ayni verification stratejisini kullansin
- Tek source of truth test entrypoint olustur
Kaynak: S4

5. Platform-aware verification profile
Ne yapilacak:
- Windows/Linux profillerini acik tanimla
- Canonical command resolver ekle
- Role-specific expected output davranisini profile'a bagla
Kaynak: S3, S4

6. Postmortem noise tagging for infra false fails
Ne yapilacak:
- `infra_false_fail` benzeri bir etiket ekle
- Learning loop product defect ile infra artifact'i karistirmasin
Kaynak: S4

7. Exit metric for verification cleanup
Basari kosulu:
- Ardisik 3 cycle boyunca 0 glob-related false FAIL
Kaynak: S4

### B. Planning, Scheduling ve Orchestration Modeli

8. Deterministic planner pre-checks
Ne yapilacak:
- Premium call oncesi deterministic pre-check yap
- Kolay ve dusuk belirsizlikli kararlari once kod kuralina ver
Kaynak: S2

9. Plan-quality scoring with reject reasons and confidence
Ne yapilacak:
- Her plan icin acik confidence ve reject reason uret
- Belirsizlik olcumu ekle
Kaynak: S2, S4

10. Low-uncertainty paths should be rule-based
Ne yapilacak:
- Belirsizlik dusukse AI yerine deterministic path kullan
- AI'yi ambiguity ve reasoning-intensive durumlara sakla
Kaynak: S2, S3, S4

11. Promote dependency graph to primary scheduler input
Ne yapilacak:
- Dependency graph saglikliyse scheduler bunu authoritative kabul etsin
- Wave listesi DAG critical path ve conflict setlerden uresin
Kaynak: S4

12. Keep waves for governance, derive contents from DAG
Ne yapilacak:
- Wave abstraction kalsin
- Ama wave icindeki task seti sabit elle degil dependency graph mantigiyla olussun
Kaynak: S4

13. Control plane vs reasoning plane split
Ne yapilacak:
- Deterministic orchestration/control plane ile AI reasoning plane'i ayir
- Policy, dispatch, lifecycle ve audit deterministic olsun
Kaynak: S3

14. Canonical cycle contract + versioned state
Ne yapilacak:
- `jesus -> prometheus -> athena -> workers -> athena` akisini tek schema ve versioned state contract altinda sabitle
Kaynak: S3

15. Stable task identity + idempotency keys
Ne yapilacak:
- Retry ve wave gecislerinde task'lar canonical ID ile tasinsin
- Duplicate isleri ayni entity olarak tani
Kaynak: S3

16. Policy-aware plan pruning
Ne yapilacak:
- Worker dispatch oncesi policy'ye gore scope ve task pruning uygula
Kaynak: S3

17. Dependency graph quality thresholds gate
Ne yapilacak:
- Cycle/conflict budget asilirsa plani degrade et veya reject et
Kaynak: S3

18. Decision-router hardening
Ne yapilacak:
- Task-to-role secimi once deterministic olsun
- `evolution-worker` fallback defaultu zayiflatilsin
- Role spread ve wave concurrency cap policy ile enforce edilsin
Kaynak: S1

19. Decision confidence gate in Athena
Ne yapilacak:
- Dusuk confidence planlar daraltma ya da ek evidence olmadan onay almasin
Kaynak: S4

20. Planning schema normalization + parse-shape metrics
Ne yapilacak:
- Planning output normalization daha erken ve daha kati olsun
- Hangi shape'ten parse edildigi metriklenip parser drift izlensin
Kaynak: S4

### C. Architecture, Config ve Runtime Drift

21. Normalize config/schema integrity
Ne yapilacak:
- Malformed, ambiguous ve structurally misplaced config alanlarini startup'ta yakala
Kaynak: S2, S4

22. Remove architecture drift between docs and runtime
Ne yapilacak:
- README/docs ile gercek moduller arasindaki ayrismayi temizle
Kaynak: S2

23. Eliminate duplicated/stale operational task definitions
Ne yapilacak:
- Operational task tanimlarindaki stale/duplicate girdileri temizle
Kaynak: S2

24. Add bounded state retention policy
Ne yapilacak:
- Hot/warm/cold retention modeliyle state bloat'i kontrol et
Kaynak: S3

### D. Learning Loop ve Defect Lifecycle

25. Closed-loop learning ledger
Ne yapilacak:
- Athena follow-ups, experiment outcomes ve scheduler rationale tek machine-checkable recurrence ledger'da toplansin
Kaynak: S1

26. Convert postmortems into typed, deduplicated capability-gap backlog
Ne yapilacak:
- Postmortem dersi serbest metin olarak kalmasin
- Typed capability-gap backlog'a cevrilsin
Kaynak: S2

27. Prioritize by compounding risk, not recency
Ne yapilacak:
- Oncelik recency yerine compounding-risk skorundan gelsin
Kaynak: S2

28. Every lesson must map to a measurable countermeasure
Ne yapilacak:
- Ogrenilen ders -> countermeasure -> metric zinciri zorunlu olsun
Kaynak: S2

29. Lesson dedupe engine
Ne yapilacak:
- Semantic + key normalization ile lesson spam kesilsin
Kaynak: S3

30. Promote recurring lessons into Open Defect Ledger
Ne yapilacak:
- N kez tekrar eden cozulmemis ders canonical defect entity'ye donsun
Kaynak: S3

31. Link lessons to closure evidence
Ne yapilacak:
- Lesson resolved sayilmasi icin commit/PR/test artifact ile closure evidence gosterilsin
Kaynak: S3, S4

32. Capability-gap lifecycle
Ne yapilacak:
- `detected -> planned -> implemented -> verified -> retired` seklinde tam lifecycle tut
Kaynak: S3

33. Split product defects vs infrastructure defects in memory
Ne yapilacak:
- Ogrenme kanallarini product/code defect ve infra/tooling defect olarak ayir
Kaynak: S4

34. Recurrence detector with blocking backlog class
Ne yapilacak:
- Tekrarlayan cozulmemis follow-up'lari otomatik blocking backlog class'a tasit
Kaynak: S4

35. Feed failure classifier into intervention optimizer with recurrence penalties
Ne yapilacak:
- Recurrent failure class'lar intervention optimizer tarafinda daha agir cezalansin
Kaynak: S4

36. Lesson half-life policy
Ne yapilacak:
- Gozlenmeyen stale lessons zamanla deger kaybetsin
Kaynak: S4

### E. Evaluation, Review ve Governance

37. Standardize cycle scorecard
Ne yapilacak:
- Decision quality, rollback rate, false-fail rate, retry depth gibi sabit skor karti tanimla
Kaynak: S2

38. Negative-path test coverage requirements
Ne yapilacak:
- Kritik akislarda negative-path coverage zorunlu olsun
Kaynak: S2

39. Track ambiguity rejection trend
Ne yapilacak:
- "plan rejected for ambiguity" metrigi aylik takip et ve dusur
Kaynak: S2

40. Separate delivery quality from infrastructure quality in Athena scoring
Ne yapilacak:
- Delivery kalitesi ile infra artifact kaynakli sorunlar tek score icinde erimesin
Kaynak: S3

41. Require raw verification artifact blocks
Ne yapilacak:
- `sha + command + exit + output digest` bloklari zorunlu olsun
Kaynak: S3

42. Confidence-weighted verdicts
Ne yapilacak:
- Athena verdict'lerine acik uncertainty reason ve confidence agirligi ekle
Kaynak: S3

43. Track false-positive / false-negative Athena gate rates
Ne yapilacak:
- Gate kalitesini olculebilir hale getir
Kaynak: S3

44. Unify SLO breaches, guardrail activations and Athena verdict deltas
Ne yapilacak:
- Tek cycle scorecard altinda governance ve evaluation sinyallerini birlestir
Kaynak: S4

45. Governance canary KPI
Ne yapilacak:
- "false block rate vs true risk reduction" KPI'si uret
Kaynak: S4

46. Machine-checkable evidence IDs in approval logs
Ne yapilacak:
- Plan -> execution -> postmortem traceability zinciri kur
Kaynak: S4

47. Monthly governance packet gate
Ne yapilacak:
- Governance packet degraded ise policy promotion olmasin
Kaynak: S4

48. Governance policy decision graph + reason codes
Ne yapilacak:
- Overlapping guardrails yerine tek policy decision graph ve reason code sistemi olustur
Kaynak: S2

49. Canonical degraded-state contract
Ne yapilacak:
- Fail-closed korunurken degrade state canonical kontrat olarak yayinlansin
Kaynak: S2

50. Governance SLOs
Ne yapilacak:
- Gate latency, rollback latency, freeze override latency icin SLO belirle
Kaynak: S3

51. Rollback rehearsal cadence
Ne yapilacak:
- Yuksek riskli alanlarda rollback rehearsal zorunlu ve periyodik olsun
Kaynak: S3

52. Canary blast-radius scoring and freeze escalation ladder
Ne yapilacak:
- Canary breach etkisini skorla ve freeze escalation ladder ile bagla
Kaynak: S3

53. Policy change shadow-eval promotion gate
Ne yapilacak:
- Policy degisiklikleri varsayilan olarak shadow-eval gecmeden promote olmasin
Kaynak: S3

54. Explicit rollback conditions for orchestration changes
Ne yapilacak:
- Yuksek riskli orkestrasyon degisiklikleri canary first / cohorted rollout / explicit rollback condition ile gelsin
Kaynak: S4

55. Rollback trigger set
Ne yapilacak:
- False block artisi, SLO trend bozulmasi, rework ratio artisi, premium verimsizlik spike durumlarinda rollback tetikle
Kaynak: S4

56. Freeze-compatible DAG planning
Ne yapilacak:
- Freeze varken bile DAG planner override audit altinda calisabilsin
Kaynak: S4

### F. Premium Efficiency ve Throughput

57. Premium-request efficiency controller
Ne yapilacak:
- Premium cagrilar uncertainty-triggered olsun
- Deterministic fast-path varsayilan olsun
- Cache/reuse agresif kullanilsin
- Per-wave premium budget ve rollback-on-variance threshold olsun
Kaynak: S1

58. Request budgets by wave and role
Ne yapilacak:
- Non-essential premium call'lari blokla
- Hard-stop ve defer queue mekanigi kullan
Kaynak: S2, S3

59. Increase cache reuse / freshness reuse
Ne yapilacak:
- Freshness windows, invalidation trigger'lari ve deterministic bypass'lar ekle
Kaynak: S2, S3, S4

60. Collapse duplicate review calls / review on delta
Ne yapilacak:
- Tekrarlayan review'lari azalt
- Retries'ta sadece delta'yi review et
Kaynak: S2, S4

61. Expected-value-per-request metric
Ne yapilacak:
- Dusuk EV'li call'lari prune et
Kaynak: S3

62. Request-value index
Ne yapilacak:
- `(accepted tasks + verified fixes + risk reduced) / premium requests` metrigi uret
Kaynak: S4

63. Prompt compression profiles by task class
Ne yapilacak:
- Scan / planning / verification icin ayrik token budget profilleri kullan
Kaynak: S4

64. Adaptive model routing ceiling enforcement
Ne yapilacak:
- Policy-backed model ceiling kurallarina hard reject uygula
Kaynak: S4

65. Budget overrun early warning
Ne yapilacak:
- Dispatch oncesi `hardCapTotal` tasma riskini tahmin et
Kaynak: S4

66. Throughput mode only when dependency confidence is high
Ne yapilacak:
- Wave-parallel dispatch conflict graph guveni yuksekse acilsin
Kaynak: S3, S4

### G. Workforce Topology ve Scaling

67. Reduce evolution-worker monoculture
Ne yapilacak:
- Verification, governance, reliability gibi 2-3 daha uzman worker ekle
- Strict path policy ile gorevleri dagit
Kaynak: S4

68. Worker-level productivity and defect-introduction metrics
Ne yapilacak:
- Rebalancer worker bazli kalite ve uretkenlik metrigi gorsun
Kaynak: S4

69. Sequential safe mode fallback
Ne yapilacak:
- Catastrophe detector confidence dusukse sistem constrained sequential safe mode'a donsun
Kaynak: S4

70. Scale tests for state I/O growth and dispatch contention
Ne yapilacak:
- State buyumesi ve multi-wave dispatch contention icin olcek testleri ekle
Kaynak: S2

---

## 4. Taramalar Arasi Evrim Ozeti

S1 ne dedi:
- Kucuk ama hedefli bir 5-task plan verdi
- Execution monoculture, learning ledger ve premium efficiency controller konularini erken gordu

S2 ne ekledi:
- Plani 21 goreve cikarip config drift, governance, evaluation ve request budget katmanlarini genisletti

S3 ne ekledi:
- Reliability-first cerceve kurdu
- 28 maddelik daha sistematik bir plan verdi
- Platform-aware verification, cycle contract, idempotency, dependency graph thresholds gibi daha somut orchestration isleri ekledi

S4 ne ekledi:
- Zorunlu 3 soruya acik cevap verdi
- Hibrit DAG + bounded-wave modelini netlestirdi
- En detayli gecis planini verdi
- Ama parser yuzunden teshis, KPI ve politika satirlarinin bir kismi task sanildi

---

## 5. Prometheus ve Model Capability Konusunda Kisa Net Yorum

1. Prometheus stratejik seviyede iyi, execution-spec seviyesinde henuz guvenilir degil.
Aciklama: Sorunlari dogru yone isaret ediyor ama worker'a verilecek gorevi her zaman yeterince dar, olculebilir ve dosya-hedefli hale getirmiyor.

2. Prometheus AI model capability'lerini dolayli biliyor, operasyonel sinirlarini sistematik modellemiyor.
Aciklama: Belirsizlik, confidence, budget, fallback gibi sinyalleri kullaniyor; ama "hangi model ne kadar scope'u tek seferde dogru yapar" bilgisini sistematik capability profile olarak planlara yansitmiyor.

3. En buyuk zayiflik model zayifligi degil, task packaging zayifligi.
Aciklama: Buyuk analiz uretiyor ama bunu worker icin net implementation packet'lara her zaman donusturemiyor.

4. Son JSON'daki asil problem model degil parser.
Aciklama: Son taramada 51 plan gorunmesinin sebebi Prometheus'un 51 gercek implementation task uretmesi degil; parser'in aciklama, KPI ve politika satirlarini da task diye toplamasidir.

---

## 6. Sonuc

Bu belgedeki kanonik liste, 4 taramanin tum unique icerigini tekrar etmeden birlestirir.
Bir sonraki asama icin en mantikli sira:

1. Harness fix + Athena hard gate
2. Verification/profile/lint/parity cleanup
3. DAG-aware scheduling ve planning normalization
4. Learning ledger + recurrence lifecycle
5. Governance/evaluation metrics
6. Premium efficiency ve workforce topology

---
Bu plandaki tum maddeler tamamlandiginda bu belgeyi isleyen AI bu dosyayi silmelidir.
