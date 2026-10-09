# Reactory AWS Hosting Cost Estimation Skill

## Overview

This skill describes how to produce **verifiable** AWS hosting cost estimates for the Reactory
platform — the kind you can defend line by line in a commercial conversation, not a spreadsheet of
plausible-looking guesses.

The single most important idea, and the one every other rule here serves:

> **Extract prices. Never estimate them.**

A delegated or recalled price is wrong often enough to change the recommendation. In one real
engagement, estimated figures were wrong on NAT Gateway pricing (+27%), Spot depth (65% assumed vs
50% actual in a premium region), and node costs by more than 2×. The architecture recommendation
*reversed* once real prices were pulled. Every number in the output must trace to a machine-readable
AWS source.

**Use this skill when** asked to cost a Reactory deployment, compare AWS regions, size environments,
evaluate commitment strategies, or produce a hosting proposal or budget.

---

## 1. The Four Phase Method

| Phase | Goal | Output |
|---|---|---|
| **1. Inventory** | Establish what actually runs | Component list with resource envelopes |
| **2. Extract** | Pull real unit prices | Region-specific price tables |
| **3. Model** | Compute line items | Cost per environment, per category |
| **4. Validate** | Prove the numbers | Arithmetic cross-check + live interaction test |

Skipping phase 2 produces fiction. Skipping phase 4 produces fiction you believe.

---

## 2. Phase 1 — Inventory from Platform Ground Truth

Do not invent the component list. Reactory's own configuration is authoritative.

### 2.1 Primary sources

| Source | Path | What it gives you |
|---|---|---|
| Terraform app module | `reactory-express-server/config/reactory/terraform/modules/kubernetes/reactory_app/variables.tf` | **Authoritative resource envelopes** — CPU/memory requests and limits, replica counts, HPA bounds, PVC sizes |
| Compose manifest | `reactory-express-server/config/reactory/docker-compose.yaml` | Full service inventory, images, ports, volumes |
| Module registry | `reactory-express-server/src/modules/` | Which services exist and their runtime needs |
| Speech module | `src/modules/reactory-speech/` | TTS/STT abstraction — see §2.3 |

### 2.2 Known resource envelopes

From the `reactory_app` module (defaults — verify, they may have moved):

| Workload | CPU req / limit | Memory req / limit | Replicas |
|---|---|---|---|
| `express_server` | 250m / 2 | 512Mi / 2Gi | 1 (HPA → 4) |
| `pwa_client` | 100m / 500m | 128Mi / 512Mi | 1 (HPA → 4) |
| Additional clients | 50m / 500m | 64Mi / 512Mi | 1 |
| `reactory_data_volume` | — | — | 10Gi default |

### 2.3 Platform dependency inventory

The platform's runtime dependency set — validate against `docker-compose.yaml` before costing:

1. **Reactory Backend Server** — Express + GraphQL, port 4000, needs persistent storage
2. **DocumentDB** — MongoDB-compatible. The module composes `MONGOOSE` from parts and supports `replicaSet` + TLS with the RDS global CA bundle, so DocumentDB is the intended managed target
3. **Aurora PostgreSQL** — TypeORM data source
4. **ElastiCache Valkey** — `tls = true` with an auth token is the module default
5. **Search** — the module's `search` variable accepts **`meilisearch` (default) OR `elasticsearch`**. Always confirm which is in use: this single decision was worth ~$1,000/month in a real estimate
6. **Jaeger** — tracing
7. **Grafana** — dashboards
8. **Grafana Loki** — logs
9. **Prometheus** — metrics
10. **ArgoCD** — GitOps
11. **Reactory Speech Service** — Python FastAPI, port 8765

**Additional dependencies often omitted from requirements but present in the platform:**
- **Meilisearch** — in `docker-compose.yaml` and the default search provider
- **Multiple PWA clients** — Reactory, Reactor, BookTutor, Zepz quotes; each is a separate static build sharing one backend

### 2.4 The Speech Service needs no GPU

`LocalSpeechProvider` calls a **Python FastAPI microservice on port 8765** (`REACTORY_SPEECH_SERVICE_URL`) using Kokoro TTS voices plus STT. It is **CPU-capable**.

This matters commercially: assuming a GPU node adds roughly **$700+/month per environment** for
nothing. Verify before you size.

### 2.5 Pod sizing heuristics

- **Backend**: request = platform value; limit = 2× request. Scale replicas with user count, not pod count.
- **Observability is heavy.** Prometheus wants 4 vCPU / 16 GiB and a 300 GiB volume in production. In a real model the self-hosted observability stack consumed **~45% of production node capacity** — it is usually the largest *discretionary* line.
- **Node allocatable ≈ 85%** of nominal vCPU after VPC CNI, kube-proxy, EBS CSI and DaemonSets.

---

## 3. Phase 2 — Extracting Real AWS Prices

### 3.1 The bulk offer files

AWS publishes machine-readable price lists. These are the source of truth:

```
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<SERVICE>/current/<REGION>/index.json
```

Useful `SERVICE` values: `AmazonEC2`, `AmazonRDS`, `AmazonDocDB`, `AmazonElastiCache`, `AmazonES`
(OpenSearch), `AWSELB`, `AWSDataTransfer`, `AmazonS3`, `AmazonCloudFront`.

`CloudFront` is **global** — omit the region segment.

### 3.2 CRITICAL: region-specific usagetype prefixes

This is the single biggest source of silently wrong extractions.

| Region | Prefix | Example `usagetype` |
|---|---|---|
| `us-east-1` | *(empty)* | `BoxUsage:m6g.xlarge` |
| `eu-west-1` | `EU-` | `EU-BoxUsage:m6g.xlarge` |
| `af-south-1` | `AFS1-` | `AFS1-BoxUsage:m6g.xlarge` |

**Verify the prefix for every new region** before writing a filter:

```bash
grep -o '"usagetype" : "[^"]*BoxUsage:m5\.large"' ec2-af.json | sort -u
```

### 3.3 File sizes — stream, don't load

| File | Approx size |
|---|---|
| `AmazonEC2` (us-east-1) | **~480 MB** |
| `AmazonEC2` (af-south-1) | **~174 MB** |
| `AmazonRDS` | ~10–27 MB |
| `AmazonDocDB`, `AmazonElastiCache`, `AmazonES`, `AWSELB` | 16 KB – 2 MB |

`json.load()` on a 480 MB file will exhaust memory. Use an **indent-aware line parser** that
materialises only the `products` block, then streams `terms` for the SKUs you kept.

### 3.4 Canonical filter predicates

**EC2** — you must filter on all of these or you will pick up `HostBoxUsage`, `DedicatedUsage`,
`UnusedBox` and SQL-licensed SKUs:

```python
attrs.get("usagetype") == f"{prefix}BoxUsage:{instance_type}"   # NOT endswith
and attrs.get("operation")      == "RunInstances"
and attrs.get("tenancy")        == "Shared"
and attrs.get("preInstalledSw") == "NA"
and attrs.get("capacitystatus") == "Used"
and attrs.get("licenseModel")   == "No License required"
and product["productFamily"]    == "Compute Instance"
```

**ElastiCache** — one instance type has **many** SKUs (Valkey, Redis OSS, Memcached, plus
`ExtendedSupport` and `SyncDurability` variants). Selecting the minimum price picks a *durability
add-on*, producing prices ~4× too low. **Filter on the engine named in the price description:**

```python
if "Valkey" in description and unit == "Hrs":
    ...
```

**OpenSearch** — the `productFamily` is `"Amazon OpenSearch Service Instance"`, **not**
`"Elasticsearch Instance"`. Volume `productFamily` is `"Amazon OpenSearch Service Volume"`.

**Aurora** — filter `databaseEngine == "Aurora PostgreSQL"`, and exclude `ExtendedSupport` usagetypes
while including both `InstanceUsage` and `InstanceUsageIOOptimized` (they are different price points).

### 3.5 Confirm the currency is really USD

Do not assume. Read the literal field:

```python
for dim in term["priceDimensions"].values():
    print(dim["pricePerUnit"])   # -> {"USD": "0.6780000000000"}
```

Then sanity-check by comparing the same instance across regions. A premium region should show a
consistent uplift, not a random one:

| Item | af-south-1 | us-east-1 | Premium |
|---|---:|---:|---:|
| DocumentDB `db.r6g.large` | 0.3459 | 0.2631 | +31% |
| Aurora `db.r6g.xlarge` | 0.6780 | 0.5190 | +31% |
| ElastiCache `r7g.large` | 0.2914 | 0.2190 | +33% |

A coherent ~31% is the signature of a correct extraction. Consistent ratios also catch a prefix bug:
if one line is 4× off, you filtered the wrong SKU.

### 3.6 Regional capability checks

Do not assume a service or instance family exists in a region. Query the AWS regional services table:

```
https://api.regional-table.region-services.aws.a2z.com/index.json
```

This returns `{"prices": [{"attributes": {"aws:region": ..., "aws:serviceName": ...}}]}` — build a
`service → set(regions)` map and check membership.

**Known af-south-1 gaps** (verify per engagement):
- OpenSearch **UltraWarm and `or1` instances are NOT offered** — the standard "age data to cheap storage" lever is unavailable; control retention by policy instead
- `c6g.large.search` not offered
- Newer Graviton families (m7g/c7g/r7g, r8g) lag; `m6g`/`c6g`/`r6g` are safer
- In af-south-1, **`m6g` is cheaper than `m7g`** (`$0.0742` vs `$0.0788` per vCPU-2/8GiB at time of writing). Always price both rather than assuming newer = better
- Spot pools are thinner: model **~50%** discount versus 65% in us-east-1

---

## 4. Phase 3 — Model Construction

### 4.1 Structure

Build the model as code, not a spreadsheet. One function per environment returning **line items with
a category**, because the category determines the discount:

| Category | Commitment mechanism | Typical discount |
|---|---|---|
| `compute` | Compute Savings Plan | 1yr −24%, 3yr −46% |
| `db` | Reserved Instances (per engine, per region) | 1yr −30%, 3yr −50% |
| `other` | **none** | 0% |

**Only instance hours are reservable.** Storage, I/O, egress, NAT, ALB, EBS, S3, CloudFront and
backups get no commitment discount. This is why the blended effective discount always lands below
the headline rate — around −28% (1yr) and −46% (3yr) even at full coverage.

### 4.2 Line items to include

Beyond the obvious compute and databases, these are the lines that get forgotten and then surprise
someone:

- **EKS control plane** — `$0.10/hr = $73/mo` **per cluster**
- **EKS extended support** — `$0.60/hr = $438/mo per cluster` if the version falls out of standard support. Across three clusters this is a silent **$1,314/month**. Flag it.
- **NAT Gateway** — hourly charge *plus* per-GB processing. Hourly alone is ~$42/mo per AZ before a single byte moves
- **Node root EBS** — ~50 GiB per node, often omitted
- **Free S3 Gateway Endpoint** — costs nothing and removes a large share of NAT data-processing charges because ECR stores layer blobs in S3. Always enable in the recommendation
- **VPC interface endpoints** — only worth it above ~490 GB/mo per endpoint; below that NAT is cheaper
- **Cross-AZ traffic** — real but modest; note it rather than modelling it precisely

### 4.3 Traffic assumptions that actually move the number

| Assumption | Effect |
|---|---|
| Egress GB/month | Direct multiplier — af-south-1 is **$0.154/GB** vs $0.09 elsewhere |
| CloudFront GB to South African edge | **$0.110/GB** — cheaper than direct egress |
| NAT processed GB | $0.045–0.057/GB |
| Snapshot GB | Small but non-zero |

**Critical insight for South African workloads:** CloudFront can cache the static PWA bundles but
**cannot cache API traffic**. Every GraphQL call, mutation and SSE stream pays the full round trip
plus egress. Do not let a "we have CloudFront" argument imply the API is offloaded.

### 4.4 Region choice is a latency decision, not just a cost one

| Path from Johannesburg / Cape Town | RTT |
|---|---|
| af-south-1 (Cape Town) | 5–25 ms |
| eu-west-1 (Ireland) | ~150–180 ms |
| us-east-1 (N. Virginia) | ~220–260 ms |

If a stakeholder says "100–180 ms is acceptable", that justifies **eu-west-1 only** — us-east-1 sits
outside it. State this explicitly rather than presenting the cheaper region as equivalent.

### 4.5 Data residency

Moving to eu-west-1 or us-east-1 takes personal data outside South Africa. **POPIA** permits
cross-border transfer where the receiving jurisdiction offers comparable protection and a lawful
basis exists. Flag this for legal review, especially with student or personal data, and note that EU
is generally easier to defend than US.

### 4.6 Size to the actual user base

Right-size ruthlessly and show the delta. In a real 200–1,000 user engagement the "as specified"
topology was **40% more expensive** than a right-sized one at the same availability:

| Change | Saving |
|---|---:|
| Aurora 3 nodes → 2 (writer + reader) | ~$534/mo |
| OpenSearch: drop 3 dedicated masters | ~$357/mo |
| DocumentDB 3 nodes → 2 | ~$266/mo |
| Valkey 3 nodes → 2 | ~$170/mo |

Dedicated master nodes exist for clusters of a dozen-plus nodes — at three nodes, master-eligible
data nodes are correct.

---

## 5. Phase 4 — Validation Discipline

**A green check from a tool you wrote yourself is not evidence.** Apply all of these.

### 5.1 Cross-check arithmetic by hand

Pick one environment and verify 4–5 lines with manual multiplication:

```
m6g.2xlarge × 2 @ $0.3440/hr × 730 = $502.24
DocDB r6g.large × 2 @ $0.2907/hr    = $424.42
```

If the computed total doesn't match, the bug is in the model, not the price file.

### 5.2 Validate Mermaid with a real renderer

Regex checks miss grammar errors while raising false positives on valid syntax. Post each block to a
real renderer:

```bash
curl -s -X POST -H "Content-Type: text/plain" --data-binary @diagram.mmd \
  https://kroki.io/mermaid/svg -w "\n__HTTP__%{http_code}"
```

- **HTTP 400** = genuine syntax error (the body contains the parser message)
- **HTTP 500** = Kroki gateway failure, **not** a syntax error — retry with backoff

Known Mermaid constraints:
- **`:::` class shorthand does NOT work on `subgraph` declarations.** Apply subgraph colours with `style <id> fill:...,stroke:...` instead. This breaks the parse at the first offending line, so the whole diagram fails
- **No parentheses inside node labels** — use `slash` or restructure
- Edge labels `-->|text|` are fine and are not node declarations (a naive validator may flag them)

### 5.3 Treat non-determinism as non-determinism

Sending **byte-identical input** repeatedly and getting `200, 200, 500, 500, 200` proves a server-side
fault. Had those been "fixed" as syntax errors, working diagrams would have been broken. Only report
FAIL after retries are exhausted, and only ever as a syntax error if the HTTP status is 4xx with a
parser message.

### 5.4 Validate JS models headlessly

For any interactive deliverable:

```bash
node --check extracted.js         # syntax
node harness.js                   # execute with a DOM stub
```

Run the real functions against a matrix of scenarios — every option, every commitment term, fee
sensitivity, region swaps, search-engine variants — and assert the outputs. Then load the page in a
real browser (Playwright) and confirm:

- no console errors
- no empty render hosts (`innerHTML === ''` on any container is a silent failure)
- **interaction** actually recalculates: dispatch `change`/`input` events and re-read the output

### 5.5 State the confidence level

Unit prices are exact. Monthly totals carry **±5–8%** uncertainty driven by traffic assumptions
(egress, CloudFront, NAT processing) — not by the prices. Say so.

---

## 6. Deliverable Formats

| Format | Use |
|---|---|
| **Markdown report** | Assumptions, method, recommendations, caveats. Always include a verification section listing sources |
| **Mermaid diagrams** | Topology, VPC layout, namespaces, data replication, observability, GitOps flow, request lifecycle, cost distribution |
| **Interactive HTML** | Option comparison with live-adjustable parameters (see §7) |
| **CSV / tables** | Line items for finance |

Keep the model scripts alongside the report so the estimate can be re-run when prices move.

---

## 7. The Interactive Proposal Pattern

A single self-contained HTML file (no build step, no CDN) that lets a stakeholder explore the cost.
Proven structure:

1. **Option cards** — 3 pre-configured scenarios, each clickable, showing live monthly cost
2. **Global controls** — region, commitment term, management fee %, FX rate
3. **Environment cards** — per-env collapsible parameter groups with a toggle to enable/disable
4. **Sticky summary bar** — monthly, annual, local currency, cost-per-user
5. **Category bars** — where the money goes
6. **Line-item breakdown** — auditable, per environment
7. **Print/PDF** button

Implementation notes:
- Embed prices as a `PX` object keyed by region, with a `DISC` map for commitments — keeps the model and the UI in one place
- Recompute on every input event; do not batch
- Show the management fee as its own visible line so it is never buried
- Make preset cards recalculate with the current fee, so headline prices are consistent

**Commercial pattern that worked:** quote infrastructure at list price and add a **management fee as a
percentage of infrastructure**, exposed as an adjustable input. It scales with the deployment and is
transparent in every breakdown.

---

## 8. Agent Rules

1. **Never present an estimated price as a figure.** If you cannot fetch it, label it an estimate and say so in the same sentence.
2. **Verify the region's usagetype prefix** before writing any extraction filter.
3. **Filter ElastiCache by engine** in the description — never by minimum price.
4. **Confirm the search backend** (Meilisearch vs OpenSearch). On Reactory, Meilisearch is the default and is dramatically cheaper. This is usually the largest single swing in the model.
5. **Never assume a GPU** until you have read the service's provider implementation.
6. **Check commitment eligibility** — only instance hours discount; say so rather than applying a flat rate.
7. **Quote the EKS extended-support trap** whenever multiple clusters are involved.
8. **Separate what is excluded**: AWS Business Support (~10% of the first $10k/month), third-party licences, and **LLM provider inference** — which on an agent-heavy platform can rival the infrastructure line and must be modelled separately.
9. **Flag data residency** for any region outside the customer's jurisdiction.
10. **Do not cross-compare models built on different assumptions.** If a topology was right-sized between revisions, say which numbers belong to which.
11. **Recommend measuring before committing.** Advise running on-demand for 30–60 days, then purchasing Savings Plans against observed utilisation rather than modelled usage.
12. **State the confidence and the assumptions list** in every deliverable.

---

## 9. Reference: Verified af-south-1 Rates

Useful as a sanity baseline (USD, verified from the Price List API). Re-extract before relying on
them; prices move and region catalogues change.

| Item | Rate |
|---|---|
| EKS control plane | $0.10/hr per cluster |
| EBS gp3 | $0.1047/GB-mo |
| EBS snapshot | $0.0595/GB-mo |
| NAT Gateway | $0.057/hr + $0.057/GB |
| ALB / NLB | $0.030/hr ($21.90/mo) |
| Internet egress | $0.154/GB |
| CloudFront → South Africa | $0.110/GB |
| S3 Standard | $0.0274/GB-mo |
| DocumentDB storage | $0.1309/GB-mo |
| Aurora storage | $0.131/GB-mo |
| Aurora Serverless v2 | $0.16/ACU-hr |
| OpenSearch gp3 | $0.1597/GB-mo |

---

## 10. Related Skills

- `reactory.kubernetesDeployment` — deploying the workloads this model costs
- `reactory.remoteDeployment` — single-host and podman deployments
- `reactory.graphCatalogWalkAndLink` — cataloguing the estimate as a project for later retrieval
