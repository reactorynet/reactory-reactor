# cost_analysis.ipynb test plan

## Validation approach
Notebook execution itself is checked in CI by running it with papermill against a small fixture DB. Because the jest test suite doesn't drive Python, this plan documents what to verify manually before merging changes that touch the notebook.

## Manual checks

1. **Smoke test against local Mongo** — `papermill cost_analysis.ipynb /tmp/out.ipynb` runs without errors when no events match (handles empty dataframe).
2. **Filter by date** — `-p START_DATE 2026-04-01 -p END_DATE 2026-04-30` restricts the query and the cost-per-conversation table reflects only that window.
3. **Filter by user** — `-p USER_ID <hex>` returns only that user's rows in every grouping.
4. **Provider/model breakdown** — bar chart renders without errors; top-N truncation works.
5. **Budget vs actual** — when `reactor_user_budgets` is empty, the cell prints "No budgets configured" and continues; when populated, the table joins correctly.
6. **OUTPUT_DIR parameter** — `-p OUTPUT_DIR /tmp/cost-output` writes three CSVs.
7. **Pricing-source robustness** — events with `pricingSource: 'unpriced'` contribute 0 to totals (verified by checking that `costs.totalUsdCents` already reflects the runtime classification — no additional handling in the notebook).

## Out of scope
- Recomputing prices from YAML — the notebook deliberately reads denormalized cost fields, never re-prices.
- Graphs of historical price changes — that would require pricing snapshots over time, separate analysis.
