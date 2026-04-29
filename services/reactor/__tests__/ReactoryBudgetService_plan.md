# ReactoryBudgetService test plan

Module: `src/modules/reactory-reactor/services/reactor/ReactoryBudgetService.ts`

## Goals
- Verify period bound calculation handles UTC, ahead-of-UTC, behind-UTC, DST, and week start configuration.
- Verify `checkBudget` returns the right status across thresholds.
- Verify alert publishing is idempotent per period crossing.
- Verify `assertWithinBudget` throws `BudgetExceededError` only on hard breach.

## Coverage of `getPeriodBounds`

1. **Day in UTC** — start is 00:00 UTC, end is +24h.
2. **Day in Africa/Johannesburg** — start is 22:00 UTC previous day (UTC+2 → midnight local = 22:00 UTC).
3. **Day in America/New_York during EDT** — DST-aware offset.
4. **Week starting Monday in UTC** — start is the Monday of the current week at 00:00 UTC.
5. **Week starting Sunday in UTC** — start shifts back one day vs Monday.
6. **Month in UTC** — start is the 1st of the month, end is the 1st of the next month.
7. **Month at year boundary** — December → next month is January of the following year.

## Coverage of `checkBudget`

8. **No budget doc → status 'no-budget'** — short-circuits without aggregation.
9. **Inactive budget → 'no-budget'** — `active: false` is treated like missing.
10. **Under all limits → 'ok'** — all periods report `breachedHard: false`, `breachedSoft: false`.
11. **At soft threshold → 'soft-warn'** — single period over 80% but under 100%.
12. **At hard limit → 'hard-block'** — single period at 100%.
13. **`hardBlock: false` on a period** — over limit but doesn't trigger hard-block; falls through to soft-warn or ok.
14. **Scoped budget filters spend** — events outside `scope.providerIds` are not summed.
15. **Multiple periods, mixed states** — day=hard, month=ok → status is 'hard-block'.

## Coverage of alert publishing

16. **First crossing publishes alert** — soft-warn alert row created with correct fields.
17. **Second call same period → idempotent** — unique index rejects duplicate; method returns without throwing.
18. **New period → new alert** — once the period boundary changes, a new alert is allowed.

## Coverage of `assertWithinBudget`

19. **'ok' status returns the result** without throwing.
20. **'hard-block' throws BudgetExceededError** with the budget detail attached.
21. **'soft-warn' returns the result** without throwing.

## Approach

- Pure-function `getPeriodBounds` tests run without any mocks.
- `checkBudget` and `publishAlert` tests mock `ReactoryUserBudgetModel`, `ReactoryUsageEventModel`, `ReactoryUsageAlertModel`.
