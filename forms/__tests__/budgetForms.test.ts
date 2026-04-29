import { parse } from 'graphql';
import UserBudgetAdminForm from '../userBudgetAdmin';
import UsageDashboardForm from '../usageDashboard';

describe('UserBudgetAdminForm', () => {
  it('has the expected identity', () => {
    expect(UserBudgetAdminForm.id).toBe('reactor.UserBudgetAdminForm@1.0.0');
    expect(UserBudgetAdminForm.nameSpace).toBe('reactor');
    expect(UserBudgetAdminForm.name).toBe('UserBudgetAdminForm');
    expect(UserBudgetAdminForm.version).toBe('1.0.0');
    expect(UserBudgetAdminForm.roles).toEqual(expect.arrayContaining(['ADMIN']));
  });

  it('has a valid object schema with userId required', () => {
    expect(UserBudgetAdminForm.schema).toBeDefined();
    const s = UserBudgetAdminForm.schema as any;
    expect(s.type).toBe('object');
    expect(s.required).toContain('userId');
    expect(s.properties.day).toBeDefined();
    expect(s.properties.week).toBeDefined();
    expect(s.properties.month).toBeDefined();
    expect(s.properties.day.properties.limitUsdCents).toBeDefined();
    expect(s.properties.day.properties.softThresholdPct).toBeDefined();
    expect(s.properties.day.properties.hardBlock).toBeDefined();
  });

  it('defines query and mutations against the budget endpoints', () => {
    const g = UserBudgetAdminForm.graphql as any;
    expect(g.query?.name).toBe('ReactorUserBudget');
    expect(g.mutation?.new?.name).toBe('ReactorSetUserBudget');
    expect(g.mutation?.delete?.name).toBe('ReactorClearUserBudget');
  });

  it('GraphQL operation strings parse', () => {
    const g = UserBudgetAdminForm.graphql as any;
    expect(() => parse(g.query.text)).not.toThrow();
    expect(() => parse(g.mutation.new.text)).not.toThrow();
    expect(() => parse(g.mutation.delete.text)).not.toThrow();
  });

  it('mutation variables map every required field on the input', () => {
    const g = UserBudgetAdminForm.graphql as any;
    const mutVars = g.mutation.new.variables;
    expect(mutVars['formData.userId']).toBe('input.userId');
    expect(mutVars['formData.active']).toBe('input.active');
    expect(mutVars['formData.day.limitUsdCents']).toBe('input.day.limitUsdCents');
    expect(mutVars['formData.month.hardBlock']).toBe('input.month.hardBlock');
  });
});

describe('UsageDashboardForm', () => {
  it('has the expected identity', () => {
    expect(UsageDashboardForm.id).toBe('reactor.UsageDashboardForm@1.0.0');
    expect(UsageDashboardForm.nameSpace).toBe('reactor');
    expect(UsageDashboardForm.name).toBe('UsageDashboardForm');
    expect(UsageDashboardForm.version).toBe('1.0.0');
  });

  it('exports the dashboard widget as a compiled module', () => {
    const modules = UsageDashboardForm.modules as any[];
    expect(Array.isArray(modules)).toBe(true);
    expect(modules.length).toBeGreaterThan(0);
    const widget = modules.find((m) => m.id === 'reactor.UsageDashboardWidget@1.0.0');
    expect(widget).toBeDefined();
    expect(widget.compiler).toBe('rollup');
    expect(widget.fileType).toBe('tsx');
    expect(typeof widget.src).toBe('string');
    expect(widget.src.length).toBeGreaterThan(0);
  });

  it('uiSchema references the dashboard widget by name', () => {
    const ui = UsageDashboardForm.uiSchema as any;
    expect(ui.dashboard?.['ui:widget']).toBe('UsageDashboardWidget');
  });

  it('widgetMap maps the widget FQN to the widget name used by the uiSchema', () => {
    const wm = UsageDashboardForm.widgetMap as any[];
    expect(wm).toContainEqual(
      expect.objectContaining({
        componentFqn: 'reactor.UsageDashboardWidget@1.0.0',
        widget: 'UsageDashboardWidget',
      }),
    );
  });

  it('argsSchema accepts userId for parameterization', () => {
    const args = UsageDashboardForm.argsSchema as any;
    expect(args.properties.userId).toBeDefined();
  });
});
