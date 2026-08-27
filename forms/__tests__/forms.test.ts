import { describe, it, expect } from "@jest/globals";
import forms from '../index';
import UsageDashboardForm from '../UsageDashboard';
import UserBudgetAdminForm from '../UserBudgetAdmin';

describe('Reactor Forms Registration', () => {
  it('registers UsageDashboardForm with correct properties', () => {
    expect(UsageDashboardForm.id).toBe('reactor.UsageDashboardForm@1.0.0');
    expect(UsageDashboardForm.name).toBe('UsageDashboardForm');
    expect(UsageDashboardForm.nameSpace).toBe('reactor');
    expect(UsageDashboardForm.version).toBe('1.0.0');
    expect(UsageDashboardForm.registerAsComponent).toBe(true);
    expect(UsageDashboardForm.schema).toBeDefined();
    expect(UsageDashboardForm.uiSchema).toBeDefined();
    expect(UsageDashboardForm.graphql).toBeDefined();
  });

  it('registers UserBudgetAdminForm with correct properties', () => {
    expect(UserBudgetAdminForm.id).toBe('reactor.UserBudgetAdminForm@1.0.0');
    expect(UserBudgetAdminForm.name).toBe('UserBudgetAdminForm');
    expect(UserBudgetAdminForm.nameSpace).toBe('reactor');
    expect(UserBudgetAdminForm.version).toBe('1.0.0');
    expect(UserBudgetAdminForm.registerAsComponent).toBe(true);
    expect(UserBudgetAdminForm.schema).toBeDefined();
    expect(UserBudgetAdminForm.uiSchema).toBeDefined();
    expect(UserBudgetAdminForm.graphql).toBeDefined();
  });

  it('exports UsageDashboardForm and UserBudgetAdminForm in the module forms list', () => {
    const ids = forms.map((f: any) => f.id);
    expect(ids).toContain('reactor.UsageDashboardForm@1.0.0');
    expect(ids).toContain('reactor.UserBudgetAdminForm@1.0.0');
  });
});
