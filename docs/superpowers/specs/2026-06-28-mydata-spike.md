# myDATA / Greek e-Invoicing — Research Spike

**Date:** 2026-06-28
**Author:** Research spike (deep-research harness, 5 parallel source agents)
**Audience:** dietcms — multi-tenant SaaS for Greek dietitians
**Purpose:** Decision-grade brief to inform build sequencing of the invoicing module.

---

## TL;DR (decision summary)

- **Two transmission paths exist:** (a) **direct to the ΑΑΔΕ myDATA REST API** — free, self-service, you own all the XML/edge-case work; (b) via a **certified e-invoicing provider (πάροχος)** — recurring cost, less spec surface, the provider carries certification/archiving/legal liability.
- **The myDATA *data-transmission* obligation already exists** (since 2021) and applies to essentially every Greek business/freelancer today. The **2026 thing is "mandatory e-invoicing"** — a *different, stronger* obligation that the invoice itself be a structured electronic document (EN 16931 / PEPPOL) through a mandated channel, and it applies **only to B2B and B2G transactions, not B2C/retail.**
- **A solo dietitian invoicing private patients (B2C) is OUT of the 2026 e-invoicing mandate** but **already IN the myDATA data-transmission obligation.** Their B2B/B2G invoices (gym, clinic-as-company, public hospital, corporate wellness) fall in scope from **1 Oct 2026 (Phase 2)**.
- **Recommendation for dietcms: build direct-to-ΑΑΔΕ myDATA for v1** (it fully and freely covers the solo dietitian's dominant B2C flow, which is exempt from the 2026 e-invoicing mandate). **Add a certified provider only when real B2B/B2G PEPPOL demand appears.** Rationale below.
- **Effort: not a 1-week module.** Happy-path "issue a service invoice + transmit + get MARK" via a mature library is ~1-2 weeks. Production-correct (classifications, VAT exemptions, withholding, credit-note vs cancel branching, error handling, idempotency) is **4-8 weeks**. Going direct adds more; going via a provider removes a chunk of it.

---

## 1. Integration paths

### (a) Direct to the ΑΑΔΕ myDATA REST API

**What it is.** A free government REST API. You POST schema-valid XML invoice documents; ΑΑΔΕ validates and returns a **MARK** (unique registration number). This is the *data-transmission / e-books* channel ("ERP users" channel), not certified e-invoice *issuance*.

**Endpoints (official v1.0.10 spec, Dec 2024):**

| Method | Production | Dev/Test (sandbox) |
|---|---|---|
| SendInvoices (POST) | `https://mydatapi.aade.gr/myDATA/SendInvoices` | `https://mydataapidev.aade.gr/SendInvoices` |
| SendIncomeClassification (POST) | `.../myDATA/SendIncomeClassification` | `https://mydataapidev.aade.gr/SendIncomeClassification` |
| SendExpensesClassification (POST) | `.../myDATA/SendExpensesClassification` | `.../SendExpensesClassification` |
| SendPaymentsMethod (POST) | `.../myDATA/SendPaymentsMethod` | `.../SendPaymentsMethod` |
| CancelInvoice (GET) | `.../myDATA/CancelInvoice?mark={mark}` | `https://mydataapidev.aade.gr/CancelInvoice` |
| RequestDocs (GET) | `.../myDATA/RequestDocs` | `.../RequestDocs` |
| RequestTransmittedDocs (GET) | `.../myDATA/RequestTransmittedDocs` | `.../RequestTransmittedDocs` |
| RequestMyIncome / RequestMyExpenses (GET) | `.../myDATA/RequestMyIncome` etc. | `.../RequestMyIncome` etc. |
| RequestVatInfo / RequestE3Info (GET) | `.../myDATA/RequestVatInfo` etc. | `.../RequestVatInfo` etc. |

Note: production paths carry the `/myDATA/` prefix; the dev host does **not**. The separate `mydatapi.aade.gr/myDataProvider/SendInvoices` path is the **provider/DAFE channel** and is only for certified providers — not for a business sending its own invoices.

- Spec: <https://www.aade.gr/sites/default/files/2024-12/myDATA%20API%20Documentation%20v1%20.0.10_official_erp.pdf>

**Credentials & registration.**
- Two headers on every call: `aade-user-id` (username) + `ocp-apim-subscription-key` (per-user API key). The pair implicitly binds to the **AFM declared at registration**, so AFM is not re-sent per call.
- **Production registration:** log in with **TAXISnet** codes at the myDATA bookkeeper portal `https://www1.aade.gr/saadeapps2/bookkeeper-web` → create a REST API user → ΑΑΔΕ issues the subscription key.
  - Direct link: `https://www1.aade.gr/saadeapps2/bookkeeper-web/bookkeeper/#!/apiSubscription?mode=api`
  - Support: `mydata.support@aade.gr` — <https://www.aade.gr/en/mydata>
- **Who can register:** any TAXISnet-credentialed business/AFM. This is self-service; you do **not** need to be a certified provider, and **no XML cryptographic signing is required** for sending your own invoices (signing fields apply only to the provider channel and POS/ΦΗΜ flows, per Α.1155/2023).

**Sandbox.** Yes — a dedicated, separate dev registration form: `https://mydata-dev-register.azurewebsites.net` ("ΦΟΡΜΑ ΕΓΓΡΑΦΗΣ ΣΤΟ myDATA REST API (ΤΕΣΤ / DEV)"). Canonical dev host is `mydataapidev.aade.gr`. (An older Azure APIM surface `mydata-dev.azure-api.net` also exists historically — treat `mydataapidev.aade.gr` as canonical.)
- Confirmed by Greek tax press, Dec 2024: <https://www.taxheaven.gr/news/69404>

**Cost.** Free from ΑΑΔΕ. (Inference flagged: the official docs/registration mention no fee anywhere; it is a tax-compliance obligation. No explicit "δωρεάν" statement was found, but there is no monetisation surface.)

**Developer effort.** HTTPS + REST, XML bodies. POST for Send*, GET (MARKs as params) for Cancel/Request*. Retrieval methods are **paginated via `nextPartitionKey`/`nextRowKey` continuation tokens** when results exceed the max. No published requests/sec number. Mature OSS library exists (see §5).

### (b) Through a certified e-invoicing provider (πάροχος ηλεκτρονικής τιμολόγησης)

**What it is.** An ΑΑΔΕ-certified company legally authorised to **issue, sign, transmit in real time to myDATA, deliver to the recipient, and archive (5 years)** invoices on a business's behalf. Each provider-issued e-invoice gets an `authenticationCode` (provider mark) plus the myDATA MARK. The provider carries the technical-conformance and transmission liability.
- Official: <https://www.aade.gr/en/mydata/e-invoicing-service-providers>, certification procedure <https://www.aade.gr/en/mydata/procedure-providers-certification>
- Official roster (JS-rendered; open in a browser to enumerate): <https://www.aade.gr/en/mydata/licensed-software-e-invoicing-providers>

**Representative providers** (names from a third-party 2026 comparison — directional, not the authoritative ΑΑΔΕ list): Epsilon Net, SoftOne, Entersoft, Edicom, Workadu, Elorus, Timologic, Megasoft; plus e-timologiera (BRATNET), IMPACT/EntersoftOne, Prosvasis, Oxygen/Pelatologio, Comgate. EDICOM markets full AADE+GSIS accreditation covering B2B/B2G/B2C.
- <https://www.lido.app/gr/paroxoi-ilektronikis-timologisis> (third-party), <https://etimologiera.gr/en/>

**API for a SaaS.** REST APIs are widely advertised. e-timologiera publishes proper developer docs (Stoplight/Swagger/ReDoc + EN/GR PDFs) covering B2B/B2C/B2G issuance, document retrieval, validation, MARK retrieval, QR retrieval.
- <https://etimologiera.gr/en/api-erp-integration-electronic-invoicing-provider-greece/>
- **Not confirmed in writing:** white-label / embeddable-into-third-party-SaaS offerings, and provider-side sandbox availability. Both require direct sales contact. **Flag this** — it's the key open question if we go this route.

**Cost (order of magnitude, EUR — all from third-party sources, treat as indicative):**
- Per-document: B2C ~€0.10→0.025, B2B ~€0.50→0.05, B2G ~€0.40→0.10, sold as prepaid unit packs.
- Monthly subscription tiers: Elorus free/€9, Timologic €10, Workadu €12, Epsilon Net ~€25 (50 docs/mo), SoftOne ~€49/user, Entersoft ~€80/user, Edicom ~€300 (enterprise).
- Low-end freelancer tier ≈ **€9-25/month**; per-doc costs are cents.

**Registration / who can register.** Contract with the provider as a business (AFM); the provider handles ΑΑΔΕ transmission. No self-certification needed.

---

## 2. The actual API (technical)

### myDATA vs timologio (the distinction)

- **myDATA** = the ΑΑΔΕ *data-transmission / e-books platform* ("ηλεκτρονικά βιβλία"). REST API + portal that receives invoice/classification *data*, validates it, assigns the **MARK**. It is **not** an invoice-issuing tool.
- **timologio** = ΑΑΔΕ's **free web/mobile app for issuing invoices** and auto-transmitting them to myDATA in real time, for businesses/freelancers without their own software. Free, at `timologio.gov.gr`, practically suited to low volume (~≤20 invoices/mo per third-party guidance). **It has no public API — you cannot embed it in dietcms.** Your users would issue invoices outside your product. Not viable for a SaaS.
- <https://www.aade.gr/en/timologio>

So: you **issue** (in an ERP/provider/timologio) and the document is **transmitted to and registered in** myDATA, which returns the MARK/UID.

### MARK vs UID vs authenticationCode

- **UID** — 40-char invoice identifier = **SHA-1 hash of 6 fields** (Issuer VAT, Date of issue, Branch number, Invoice Type, Series, Serial number/AA), ISO-8859-7 encoding. Content-hash identifier, filled by the service.
- **MARK** (Μοναδικός Αριθμός Καταχώρησης) — `xs:long` integer assigned by ΑΑΔΕ on successful registration. An invoice is only fiscally cleared once it has a valid MARK. `cancelledByMark` holds the MARK of a cancellation.
- **authenticationCode** — authentication string filled **only when transmitted via a certified provider** (SHA-1 over 10 fields incl. MARK, totals, counterpart VAT). Absent on the direct channel.

### invoicesDoc / AadeBookInvoiceType structure

`InvoicesDoc` → one or more `AadeBookInvoiceType`. Each has: `uid`, `mark`, `cancelledByMark`, `authenticationCode`, `transmissionFailure`; `issuer`/`counterpart` (PartyType), `paymentMethods`; **`invoiceHeader`** (mandatory), **`invoiceDetails`** (lines, mandatory), `taxesTotals` (doc-level taxes *except VAT*), **`invoiceSummary`** (mandatory), `qrCodeUrl`, `otherTransportDetails`.

- **invoiceHeader:** `series`, `aa`, `issueDate`, `invoiceType` (all mandatory), `currency`/`exchangeRate`, `correlatedInvoices`, `vatPaymentSuspension`, dispatch/transport fields, `specialInvoiceCategory`, etc.
- **invoiceDetails (per line):** `lineNumber`, `recType`, `quantity`, `measurementUnit`, **`netValue`** (mand), **`vatCategory`** (mand, 1-8), **`vatAmount`** (mand), `vatExemptionCategory` (1-23), `withheldAmount`+`withheldPercentCategory`, stamp duty/fees/other-taxes/deductions fields, `incomeClassification`, `expensesClassification`.
- **invoiceSummary (all mandatory, 2dp):** `totalNetValue`, `totalVatAmount`, `totalWithheldAmount`, `totalFeesAmount`, `totalStampDutyAmount`, `totalOtherTaxesAmount`, `totalDeductionsAmount`, `totalGrossValue`, plus aggregated classifications.

### Submission response

`ResponseDoc` with one `response` per entity: `statusCode` (Success | ValidationError | TechnicalError | XMLSyntaxError), `invoiceUid`, `invoiceMark`, `classificationMark`, `authenticationCode`, `cancellationMark`, `qrUrl`, and `Errors`. On Success the MARK/UID are populated.

### Key code tables (v1.0.7-accurate; see version note below)

- **invoiceType:** `1.1` Sales Invoice; `2.1` **Service Rendered Invoice** (the B2B dietitian default); `2.2/2.3` intra-community/third-country service; `5.1/5.2` **Credit Invoice** (associated/non-associated); `11.1` Retail Receipt; `11.2` **Service Rendered Receipt** (the B2C dietitian default); `11.3` Simplified; `11.4` Retail Credit Note. (Providers may only use 1.1-11.5.)
- **vatCategory:** 1=24%, 2=13%, 3=6%, 4=17%, 5=9%, 6=4%, 7=Without VAT (0% — then `vatExemptionCategory` mandatory), 8=Records without VAT (payroll/amortisations).
- **Income classification category (`category1_x`):** `category1_3` = **Provision of Services Income** (the dietitian one). Others: 1_1 commodities, 1_2 products, 1_4 fixed assets, 1_5 other income, etc.
- **Income classification type (`E3_xxx`):** `E3_561_001…007` = sales of goods & services, by channel: **001 = wholesale**, 002 = wholesale art.39a, **003 = retail (private clientele)**, 004 = retail art.39a, 005 = intra-community, 006 = third country, 007 = other. **For a dietitian the channel determines the code:** B2C private patients (retail) → **`E3_561_003`**; B2B invoicing a business (wholesale) → **`E3_561_001`**. Both pair with `category1_3` (services income). Each line amount must carry a (`classificationType` E3_xxx + `classificationCategory` category1_x) pair, and ΑΑΔΕ **validates the pairing** — wrong pairs are rejected. (Note: one secondary source loosely glossed 561_001 as "retail/wholesale"; the official enumeration is channel-specific as above — use 003 for B2C.)
- **Withholding (`withheldPercentCategory`):** 1=Interest 15%, 2=Royalties 20%, 3=Mgmt/consultant fees 20%, **7=Services provision 8%** (the common professional-fee code), 8/9=Architect/Engineer, 10=Attorney 15%, 11=Payroll, etc.

### Sandbox / test credentials

Yes — separate dev registration form `https://mydata-dev-register.azurewebsites.net`, dev host `mydataapidev.aade.gr`. Asks Username + AFM + access key. Free.

**Version note (flag):** latest in-force schema is **v2.0.1** (adds fuel invoice types 9.x/10.x and transport fields). The detailed code tables above are extracted from the fully-readable **v1.0.7** PDF; core structure/codes are stable v1.0.x→v2.0.x but **verify v2.0.1 deltas against the current XSD before coding** (the v2.0.1 PDFs were image-encoded). Versions index: <https://www.aade.gr/en/mydata/technical-specifications-versions-mydata>

---

## 3. 2026 mandate specifics

### Two distinct obligations — do not conflate

- **myDATA data transmission (since 2021, already in force):** you must *report the data* (summaries, classifications) of issued/received documents to myDATA in near-real-time. You can still issue the invoice however you like (ERP/PDF/paper) as long as the data is reported. **This already applies to essentially every Greek business and freelancer, including dietitians, today.**
- **Mandatory e-invoicing (NEW, 2026):** for in-scope transactions the invoice itself **must be a structured electronic invoice (EN 16931 / PEPPOL BIS Billing 3.0)** issued through a mandated channel and transmitted. A PDF/paper invoice no longer satisfies the obligation; a non-compliant invoice is **invalid for VAT deduction and accounting.** This is an upgrade from "report the data" to "the invoice must *be* electronic, in a mandated format, through a mandated channel."

### Dates & phasing (confirmed)

- **Phase 1** — large enterprises (gross revenue **> €1,000,000 in FY2023**): mandatory from **2 March 2026**, soft-launch/transition window **2 Mar – 3 May 2026**.
- **Phase 2** — **all other liable entities**: mandatory from **1 October 2026**, transition **1 Oct – 31 Dec 2026**. No lower threshold carves out small entities.
- **Slippage to flag:** Phase 1 was originally **2 February 2026**, postponed to **2 March 2026** by **Decision Α.1044/2026 (17 Feb 2026)**. Many EY/Deloitte/KPMG English pages still cite the old 2 Feb date — trust 2 March. Dates have slipped once; Phase 2 (1 Oct 2026) is a candidate for further slippage.
- Sources: <https://kpmg.com/us/en/taxnewsflash/news/2025/09/greece-compliance-deadlines-electronic-invoicing.html>, <https://www.taxheaven.gr/news/72877/paratash-gia-thn-hlektronikh-timologhsh>, <https://www.zeya.com/newsletters/b2b-e-invoicing-becomes-mandatory-greece-2026-what-you-need-know>

### Scope — by transaction type, not just entity size

- **IN scope:** domestic **B2B** (wholesale between Greek-GAAP entities), exports to **non-EU third countries**, and **B2G** (mandatory since June 2024).
- **OUT / optional:** **retail (λιανική) / B2C is excluded**; intra-EU B2B remains optional.

### Are solo dietitians (ελεύθεροι επαγγελματίες) in scope?

- Scope is defined by (a) being an entity under Greek GAAP (L.4308/2014) — which **includes freelancers/sole proprietors** — **and** (b) the transaction being B2B/B2G (not retail). By Phase 2 "all other liable entities" are covered with no size carve-out.
- **Practical answer:** a dietitian's **B2C invoices to private patients are OUT** of the e-invoicing mandate (they issue retail receipts, type 11.2), but they remain **IN the myDATA data-transmission obligation**. Their **B2B/B2G invoices ARE IN** the e-invoicing mandate from **Phase 2, 1 Oct 2026** (e.g. invoicing a gym, a clinic that's a separate company, a public hospital, a corporate wellness contract).
- **Uncertainty flag:** no source *explicitly names* freelancers as in/out — this is inference from entity-type + transaction-type. Confirm against the primary text of **Law 5222/2025 / Α.1128/2025** for any small-entity or freelancer exemption.

### Is a certified provider mandatory?

**No.** Compliance can be met via **(1) a certified provider (πάροχος)** OR **(2) ΑΑΔΕ's free apps — `timologio` (web) and `myDATAapp` (mobile)**, which ΑΑΔΕ states are an "equivalent solution at no cost." For **B2G**, a certified provider has effectively been the route. The mandate is about the *format and channel* (structured EN 16931 / PEPPOL), not about forcing everyone to pay a provider.

### Legal instruments (cite-able)

- **EU Council Implementing Decision (EU) 2025/502** (5 Mar 2025) — authorises Greece to mandate B2B e-invoicing, derogating from Arts 218 & 232 of Directive 2006/112/EC. Period **1 Jul 2025 – 31 Dec 2027**. <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025D0502>
- **Law 5222/2025** (ΦΕΚ Α΄ 134/28.7.2025) — amends Art. 14 of L.4308/2014; establishes the framework.
- **Decision Α.1128/2025** — scope, dates, technical specs (PEPPOL BIS Billing 3.0).
- **Decision Α.1129/2025** — implementation details.
- **Decision Α.1044/2026** (17 Feb 2026) — postpones Phase 1 to 2 March 2026.

### Penalties (Phase 1, from end of transition, single-source — treat as indicative)

Non-issuance of required e-invoice: **50% of the VAT due** on VATable transactions; **€500-€1,000 per audit** for non-VATable. <https://marosavat.com/vat-news/greece-to-mandate-b2b-e-invoicing>

---

## 4. Recommendation for a small SaaS (solo dietitians)

**Recommendation: build direct-to-ΑΑΔΕ myDATA for v1. Add a certified provider only when real B2B/B2G PEPPOL demand appears.**

**The deciding fact:** a solo dietitian's *dominant* flow is **B2C** (billing private patients), which is **exempt from the 2026 e-invoicing mandate** but **already subject to the myDATA data-transmission obligation**. That obligation is met **for free** by the direct REST API. A certified provider would charge cents-per-doc on *every* invoice — including the majority B2C ones that need no PEPPOL — to serve a B2B/B2G minority that, for a solo practitioner, may be marginal or absent. So provider-first means paying on the common case to pre-buy a capability most tenants won't use at launch.

### Tradeoff

| Dimension | Direct to ΑΑΔΕ myDATA REST | Certified provider API |
|---|---|---|
| **Per-invoice cost** | Free | Cents per doc + ~€9-25/mo tier (passed to tenant) |
| **Dev effort / spec surface** | High — you own XML schema, code tables, validation rejections, pagination, MARK idempotency | Lower — provider abstracts much of the myDATA spec |
| **Time to launch** | Slower | Faster |
| **Compliance risk** | You carry it; schema version churn (v2.0.1) is yours to track | Provider carries certification, conformance, 5-yr archiving, legal transmission liability |
| **2026 e-invoicing (PEPPOL/EN 16931)** | You must build PEPPOL/structured-invoice issuance yourself | Provider already does B2B/B2G/PEPPOL |
| **Control / lock-in** | Full control, no vendor dependency | Vendor dependency; provider-signed docs **cannot be CancelInvoice'd — credit note only** |

### Reasoning

1. **Direct covers the primary persona's actual legal obligation, for free.** The B2C dietitian needs myDATA *data transmission*, not PEPPOL e-invoicing. The direct REST API does exactly that at zero per-doc cost, and a mature library (`firebed/aade-mydata`) removes most of the boilerplate. Paying a provider on every B2C invoice buys nothing the law requires for that flow.
2. **No provider lock-in on the common case.** Provider-signed documents **cannot be CancelInvoice'd (credit-note only)** and create a vendor dependency on your core money path. Direct keeps full control of cancellation and the invoice lifecycle.
3. **The PEPPOL/B2G capability a provider offers is genuinely useful — but only when a tenant needs it.** Defer it. When B2B/B2G demand actually appears (a tenant invoicing a gym chain, a clinic-as-company, a public hospital), integrate one provider *behind the same internal invoicing interface* and route only those invoices through it. You then pay per-doc only on the documents that require it.
4. **Honest counter-argument (why this isn't a slam dunk):** a provider gives you one code path, offloads schema-version churn (v2.0.1) and validation-rejection maintenance, and carries certification/archiving/legal transmission liability — real value for a small team. The direct path means *you* own the XML schema, the code tables, the error catalogue, idempotency, and per-tenant credential management. The recommendation accepts that engineering burden because the per-doc cost on the dominant B2C flow, plus cancellation lock-in, outweighs it for *solo* practitioners. **If your tenant mix turns out to be B2B-heavy, re-run this — provider-first becomes the better call.**

**Sequencing:** v1 = direct myDATA (B2C + the dietitian's myDATA obligation). Phase 2, demand-gated = add a certified provider for B2B/B2G PEPPOL behind the same interface. Before that Phase-2 build, **confirm a provider offers a multi-tenant-friendly REST API + sandbox** (sales calls: e-timologiera — best public dev docs; plus Epsilon Net / SoftOne for incumbency); white-label/sub-account-per-tenant support was not confirmable from public pages.

---

## 5. Build effort & hidden complexities

### Sizing

- **Happy path** (issue a `2.1`/`11.2` service invoice, transmit, parse MARK back) using a mature library: **~days to 2 weeks.**
- **Production-correct:** **~4-8 weeks.** It is **not a 1-week module.** Via a provider, some of this shifts to the provider; direct, it's all yours.

### Libraries (build-vs-buy ground truth)

- **`firebed/aade-mydata` (PHP, most mature):** MIT, PHP 8.1+, Guzzle-only, ~150 stars, actively maintained (v5.10.0, Mar 2026). Wraps Send/Cancel/Request*, classifications, payments, delivery notes; handles XML serialization, auth headers, MARK/UID/QR parsing, `dev`/`prod` switching. If dietcms is PHP/Laravel, this removes most boilerplate. <https://github.com/firebed/aade-mydata> (docs: <https://docs.invoicemaker.gr>)
- **Node/TS:** `aade-mydata-client` (npm, v1.2.3) — lower maturity. <https://www.npmjs.com/package/aade-mydata-client>
- **Python:** `attheodo/mydatanaut`. <https://github.com/attheodo/mydatanaut>
- Also Go (`ppapapetrou76/go-mydata-aade`), Java, .NET (`antyxsoft/AxMyData`) — thinner.
- **Implication for stack choice:** if going direct, PHP gets the best library; Node/Python mean reading the AADE PDF and patching gaps yourself.

### Hidden complexities (the edge cases that bite)

1. **Per-line income classification + E3 pairing.** Every line needs a `category1_x` + `E3_xxx` pair; ΑΑΔΕ validates the combination and rejects wrong pairs as business errors. For dietitians: `category1_3` (services) + **`E3_561_003`** for B2C private patients (retail) or **`E3_561_001`** for B2B (wholesale).
2. **VAT category + exemption reason.** Standard dietitian service = code 1 (24%). VAT-exempt/out-of-scope (small-business regime, services to third countries) needs code 7 + a mandatory `vatExemptionCategory` (1-23) — a common rejection source.
3. **Withholding tax (παρακράτηση φόρου) — the biggest solo-provider trap.** Mainly bites **B2B professional fees** (code 7 = services 8%; older 20% references exist). Usually **does NOT apply to B2C private patients.** But you must model withholding codes/amounts for the B2B subset and transmit them. Most likely feature to be skipped in MVP and most likely to draw an accountant complaint later. **Have the tenant's accountant confirm current rates/codes** (legislative history is messy: €300 threshold removed 2014 then reinstated; 20% vs 8% generic rate).
4. **Credit note vs CancelInvoice — two non-interchangeable mechanisms.**
   - `CancelInvoice(mark)` cancels a transmitted doc; **the cancellation gets its OWN MARK**. No bulk cancel — loop one MARK per call. Third-party cancellation needs the original issuer's `entityVatNumber`.
   - A **credit note (type 5.1)** must be used instead of CancelInvoice once **>24h** have passed since issuance, **and documents signed/transmitted through a certified provider cannot be cancelled at all — credit note only.** (The 24h / provider rule is corroborated across guides but the authoritative source is paywalled — **verify against the AADE API PDF before coding this branch.**)
   - Transmitted docs are **immutable** (date/AFM/number/series) — you cancel or credit-note, never edit.
5. **Idempotency & retry around MARK assignment** — you must not double-submit; design retries to be MARK-aware.
6. **Business-error handling** — ΑΑΔΕ returns coded transmission errors that must be surfaced to the user. Error catalogues: <https://www.metafuture.biz/metafuture/mydata_help_err.php>
7. **Dev vs prod base URLs + the user-id/subscription-key handshake** per tenant (each tenant registers their own AFM credentials — multi-tenant credential storage/encryption needed).
8. **Schema version churn** (v1.0.x → v2.0.1) is ongoing maintenance if direct.

### Does timologio or a provider sidestep this?

- **timologio:** sidesteps everything for the *end user*, but **has no API — useless for embedding in a SaaS.**
- **Certified provider:** sidesteps most of the spec surface (issuance, signing, transmission, archiving, conformance, PEPPOL/B2G) — at per-doc/subscription cost and the loss of direct cancellation (credit-note-only for provider-signed docs). **This is the value reserved for the demand-gated Phase 2 (B2B/B2G), per §4 — not v1.**

---

## Open items to close before building

1. **Validate the tenant B2C/B2B mix assumption** — the whole §4 recommendation hinges on solo dietitians being B2C-dominant. If early tenants are B2B-heavy, provider-first wins; re-run the decision.
2. **Verify v2.0.1 schema deltas** against the current XSD on the AADE versions page.
3. **Verify the 24h / provider-signed cancellation rules** against the official AADE API PDF.
4. **Confirm freelancer scope** and any small-entity exemption against the primary text of Law 5222/2025 / Α.1128/2025.
5. **Confirm current withholding codes/rates for dietitian B2B fees** with an accountant.
6. **(Phase 2, when B2B/B2G demand appears)** Confirm a certified provider with a multi-tenant-friendly REST API + sandbox (e-timologiera, Epsilon Net, SoftOne).

---

## Source confidence notes

- **High confidence (official ΑΑΔΕ / EU / law):** endpoints, auth headers, registration flow, sandbox, schema structure, MARK/UID/authenticationCode, code tables (v1.0.7), timologio facts, mandate dates/phasing, EU derogation, Greek law/decision numbers.
- **Medium (single-source or third-party):** provider pricing (third-party blog), penalty amounts (single source), provider REST/white-label specifics (vendor marketing, not confirmed for SaaS embedding).
- **Inference, flagged:** "API is free" (absence of pricing), freelancer in/out of scope (entity+transaction logic, not an explicit statement).
