import { describe, it, expect } from "@jest/globals";
import forms from '../index';
import UsageDashboardForm from '../UsageDashboard';
import UserBudgetAdminForm from '../UserBudgetAdmin';
import AiProvidersGridForm from '../aiProviders';
import AiModelsGridForm from '../aiModels';

describe('Reactor Forms Registration', () => {
  it('registers UsageDashboardForm as a single custom widget dashboard', () => {
    expect(UsageDashboardForm.id).toBe('reactor.UsageDashboardForm@1.0.0');
    expect(UsageDashboardForm.name).toBe('UsageDashboardForm');
    expect(UsageDashboardForm.nameSpace).toBe('reactor');
    expect(UsageDashboardForm.version).toBe('1.0.0');
    expect(UsageDashboardForm.registerAsComponent).toBe(true);
    expect(UsageDashboardForm.schema).toBeDefined();
    expect(UsageDashboardForm.uiSchema).toBeDefined();
    expect(UsageDashboardForm.graphql).toBeDefined();

    // The dashboard is a single custom widget mounted on the `dashboard`
    // property, replacing the old form-engine uiSchema wiring.
    const schemaProps = (UsageDashboardForm.schema as any).properties;
    expect(schemaProps.dashboard).toBeDefined();

    const uiSchema = UsageDashboardForm.uiSchema as any;
    expect(uiSchema.dashboard['ui:widget']).toBe('reactor.UsageDashboardWidget@1.0.0');
    expect(uiSchema['ui:field']).toBe('GridLayout');

    // The widget is contributed through widgetMap + modules (rollup/tsx).
    const widgetMap = (UsageDashboardForm as any).widgetMap as any[];
    expect(Array.isArray(widgetMap)).toBe(true);
    expect(widgetMap.some((w) => w.componentFqn === 'reactor.UsageDashboardWidget@1.0.0')).toBe(true);

    const modules = (UsageDashboardForm as any).modules as any[];
    expect(Array.isArray(modules)).toBe(true);
    expect(modules.some((m) => m.id === 'reactor.UsageDashboardWidget@1.0.0')).toBe(true);

    // The widget owns its data lifecycle: no engine-bound GraphQL remains.
    expect((UsageDashboardForm.graphql as any).queries).toEqual({});
    expect((UsageDashboardForm.graphql as any).query).toBeUndefined();

    // No metric may live in form state — only the widget's own local state
    // holds numbers, and empty data reads zero rather than a plausible fiction.
    const defaultFormValue = (UsageDashboardForm as any).defaultFormValue || {};
    ['totalTokens', 'totalCostUsd', 'modelBreakdown', 'timeSeries', 'records'].forEach((key) => {
      expect(defaultFormValue[key]).toBeUndefined();
    });
  });

  it('registers UserBudgetAdminForm as a single custom widget screen', () => {
    expect(UserBudgetAdminForm.id).toBe('reactor.UserBudgetAdminForm@1.0.0');
    expect(UserBudgetAdminForm.name).toBe('UserBudgetAdminForm');
    expect(UserBudgetAdminForm.nameSpace).toBe('reactor');
    expect(UserBudgetAdminForm.version).toBe('1.0.0');
    expect(UserBudgetAdminForm.registerAsComponent).toBe(true);
    expect(UserBudgetAdminForm.schema).toBeDefined();
    expect(UserBudgetAdminForm.uiSchema).toBeDefined();
    expect(UserBudgetAdminForm.graphql).toBeDefined();

    // Single custom widget on the `dashboard` property — same pattern as the
    // usage dashboard; the form engine owns no data bindings here.
    const schemaProps = (UserBudgetAdminForm.schema as any).properties;
    expect(schemaProps.dashboard).toBeDefined();

    const uiSchema = UserBudgetAdminForm.uiSchema as any;
    expect(uiSchema.dashboard['ui:widget']).toBe('reactor.UserBudgetAdminWidget@1.0.0');
    expect(uiSchema['ui:field']).toBe('GridLayout');

    const widgetMap = (UserBudgetAdminForm as any).widgetMap as any[];
    expect(Array.isArray(widgetMap)).toBe(true);
    expect(widgetMap.some((w) => w.componentFqn === 'reactor.UserBudgetAdminWidget@1.0.0')).toBe(true);

    const modules = (UserBudgetAdminForm as any).modules as any[];
    expect(Array.isArray(modules)).toBe(true);
    expect(modules.some((m) => m.id === 'reactor.UserBudgetAdminWidget@1.0.0')).toBe(true);

    // The widget owns its data lifecycle: no engine-bound GraphQL remains.
    expect((UserBudgetAdminForm.graphql as any).queries).toEqual({});
    expect((UserBudgetAdminForm.graphql as any).query).toBeUndefined();
  });

  it('exports UsageDashboardForm and UserBudgetAdminForm in the module forms list', () => {
    const ids = forms.map((f: any) => f.id);
    expect(ids).toContain('reactor.UsageDashboardForm@1.0.0');
    expect(ids).toContain('reactor.UserBudgetAdminForm@1.0.0');
    expect(ids).toContain('reactor.AiProvidersGrid@1.0.0');
    expect(ids).toContain('reactor.AiModelsGrid@1.0.0');
  });

  it('registers AiProvidersGridForm and AiModelsGridForm with correct definitions', () => {
    expect(AiProvidersGridForm.id).toBe('reactor.AiProvidersGrid@1.0.0');
    expect(AiProvidersGridForm.name).toBe('AiProvidersGrid');
    expect(AiProvidersGridForm.registerAsComponent).toBe(true);
    expect(AiProvidersGridForm.schema).toBeDefined();
    expect(AiProvidersGridForm.uiSchema).toBeDefined();
    expect(AiProvidersGridForm.graphql).toBeDefined();

    expect(AiModelsGridForm.id).toBe('reactor.AiModelsGrid@1.0.0');
    expect(AiModelsGridForm.name).toBe('AiModelsGrid');
    expect(AiModelsGridForm.registerAsComponent).toBe(true);
    expect(AiModelsGridForm.schema).toBeDefined();
    expect(AiModelsGridForm.uiSchema).toBeDefined();
    expect(AiModelsGridForm.graphql).toBeDefined();
  });
});
