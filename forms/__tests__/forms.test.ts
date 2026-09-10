import { describe, it, expect } from "@jest/globals";
import forms from '../index';
import UsageDashboardForm from '../UsageDashboard';
import UserBudgetAdminForm from '../UserBudgetAdmin';
import AiProvidersGridForm from '../aiProviders';
import AiModelsGridForm from '../aiModels';

describe('Reactor Forms Registration', () => {
  it('registers UsageDashboardForm with correct properties and dynamic filters', () => {
    expect(UsageDashboardForm.id).toBe('reactor.UsageDashboardForm@1.0.0');
    expect(UsageDashboardForm.name).toBe('UsageDashboardForm');
    expect(UsageDashboardForm.nameSpace).toBe('reactor');
    expect(UsageDashboardForm.version).toBe('1.0.0');
    expect(UsageDashboardForm.registerAsComponent).toBe(true);
    expect(UsageDashboardForm.schema).toBeDefined();
    expect(UsageDashboardForm.uiSchema).toBeDefined();
    expect(UsageDashboardForm.graphql).toBeDefined();

    // Verify filter schema properties
    const schemaProps = (UsageDashboardForm.schema as any).properties;
    expect(schemaProps.startDate).toBeDefined();
    expect(schemaProps.endDate).toBeDefined();
    expect(schemaProps.provider).toBeDefined();
    expect(schemaProps.model).toBeDefined();
    expect(schemaProps.personaId).toBeDefined();
    expect(schemaProps.use_case).toBeDefined();

    // Verify filter uiSchema widgets
    const uiSchema = UsageDashboardForm.uiSchema as any;
    expect(uiSchema.startDate['ui:widget']).toBe('DateWidget');
    expect(uiSchema.endDate['ui:widget']).toBe('DateWidget');
    expect(uiSchema.provider['ui:widget']).toBe('SelectWidget');
    expect(uiSchema.model['ui:options']).toBeDefined();
    expect(uiSchema.personaId['ui:options']).toBeDefined();
    expect(uiSchema.use_case['ui:widget']).toBe('SelectWidget');

    // Verify GraphQL query variables mapping
    const queries = (UsageDashboardForm.graphql as any).queries;
    expect(queries.summary.variables['formData.startDate']).toBe('filter.startDate');
    expect(queries.summary.variables['formData.endDate']).toBe('filter.endDate');
    expect(queries.summary.variables['formData.provider']).toBe('filter.provider');
    expect(queries.summary.variables['formData.model']).toBe('filter.model');
    expect(queries.summary.variables['formData.personaId']).toBe('filter.personaId');
    expect(queries.summary.variables['formData.use_case']).toBe('filter.use_case');
    expect(queries.recentRecords.variables['formData.startDate']).toBe('filter.startDate');
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
