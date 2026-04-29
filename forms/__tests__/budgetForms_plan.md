# Budget forms shape test plan

Module: `forms/userBudgetAdmin/*` and `forms/usageDashboard/*`

## Goals
- Catch typos / structural breakage in form definitions before they hit the runtime form engine.
- Verify GraphQL operation strings parse and reference the actual schema operations we exposed.
- Confirm that widget references in `uiSchema` resolve to either built-in widgets or a registered module entry.

## Coverage

1. **UserBudgetAdminForm has correct identity** — id, nameSpace, name, version, role gate.
2. **UserBudgetAdminForm schema is a valid object schema** with `userId` required and the day/week/month period sub-schemas.
3. **UserBudgetAdminForm graphql defines query and mutation** with names matching the GraphQL endpoints we built (`ReactorUserBudget`, `ReactorSetUserBudget`, `ReactorClearUserBudget`).
4. **UserBudgetAdminForm GraphQL operation strings parse** as valid GraphQL documents.
5. **UsageDashboardForm has correct identity** with widget mapped via FQN.
6. **UsageDashboardForm exports a module bundle** for the custom widget tsx (so the PWA can compile it).
7. **UsageDashboardForm uiSchema references registered widget** — `dashboard.ui:widget` matches a `widgetMap` entry.

## Out of scope
- Render testing (would require the PWA microkernel — covered manually).
- E2E mutation flow (covered by the existing service-layer integration tests).
