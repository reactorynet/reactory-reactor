import AiProvidersGridForm from '../aiProviders';
import { ProviderTableUIOptions } from '../aiProviders/uiSchema';
import AiProviderEditForm from '../aiProviders/edit';
import AiProviderCreateForm from '../aiProviders/create';
import ReactorForms from '../index';

/**
 * Guards the AI Providers admin form wiring.
 *
 * The grid previously referenced `reactor.AiProviderWorkflow@1.0.0` for its
 * add/delete buttons but that component did not exist, so both buttons were
 * inert. These tests assert that every FQN the grid resolves at runtime is
 * actually shipped in the form's `modules` bundle.
 */
describe('AI provider forms', () => {
  const moduleIds = (AiProvidersGridForm.modules || []).map((m: any) => m.id);

  it('bundles the workflow, detail panel and toolbar client modules', () => {
    expect(moduleIds).toEqual(
      expect.arrayContaining([
        'reactor.AiProviderWorkflow@1.0.0',
        'reactor.AiProviderDetailPanel@1.0.0',
        'reactor.AiProvidersToolbar@1.0.0',
      ])
    );

    (AiProvidersGridForm.modules || []).forEach((module: any) => {
      expect(typeof module.src).toBe('string');
      expect(module.src.length).toBeGreaterThan(0);
    });
  });

  it('wires the detail panel and toolbar through componentMap', () => {
    expect(ProviderTableUIOptions.componentMap).toEqual({
      DetailsPanel: 'reactor.AiProviderDetailPanel@1.0.0',
      Toolbar: 'reactor.AiProvidersToolbar@1.0.0',
    });
  });

  it('maps the expanded row onto the panel `provider` prop', () => {
    expect(ProviderTableUIOptions.detailPanelPropsMap).toEqual({ 'props.rowData': 'provider' });
  });

  it('refreshes the grid when the providers workflow publishes a change', () => {
    expect(ProviderTableUIOptions.refreshEvents).toEqual([{ name: 'reactor.AiProviderChanged' }]);
  });

  it('only references components that are bundled with the form', () => {
    const referenced: string[] = [
      ProviderTableUIOptions.addButtonProps?.onClick,
      ProviderTableUIOptions.deleteButtonProps?.onClick,
      ProviderTableUIOptions.componentMap?.DetailsPanel,
      ProviderTableUIOptions.componentMap?.Toolbar,
    ].filter((value): value is string => typeof value === 'string');

    expect(referenced.length).toBeGreaterThan(0);

    referenced.forEach((reference) => {
      // Handlers are declared as "<componentFqn>/<method>".
      const componentFqn = reference.includes('/') ? reference.split('/')[0] : reference;
      expect(moduleIds).toContain(componentFqn);
    });
  });

  it('registers create and edit editor forms', () => {
    const ids = (ReactorForms as any[]).map((form) => form.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'reactor.AiProvidersGrid@1.0.0',
        'reactor.AiProviderEdit@1.0.0',
        'reactor.AiProviderCreate@1.0.0',
      ])
    );
  });

  it('lays the provider editor out on the 12-column grid', () => {
    const ui: any = AiProviderEditForm.uiSchema;
    expect(ui['ui:field']).toBe('TabbedLayout');
    expect(Array.isArray(ui['ui:grid-layout'])).toBe(true);
    expect(ui['ui:grid-layout'].length).toBeGreaterThan(0);
  });

  it('groups the provider editor fields into tabs', () => {
    const ui: any = AiProviderEditForm.uiSchema;
    const layout: Array<{ title?: string; fields?: string[] }> = ui['ui:tab-layout'];

    expect(ui['ui:field']).toBe('TabbedLayout');
    expect(layout.map((tab) => tab.title)).toEqual(['Identity', 'Connection', 'Access', 'Limits']);

    // Every field named by a tab must exist in the schema, otherwise the tab
    // (or the field) would silently vanish from the editor.
    const schemaProperties = Object.keys((AiProviderEditForm.schema as any).properties);
    const tabFields = layout.flatMap((tab) => tab.fields ?? []);
    tabFields.forEach((field) => expect(schemaProperties).toContain(field));

    // No field is left out of the tabs.
    expect(new Set(tabFields)).toEqual(new Set(schemaProperties));
  });

  it('renders the nested rate-limits object as a padded section with its own grid', () => {
    const ui: any = AiProviderEditForm.uiSchema;
    expect(ui.rateLimits['ui:options']).toEqual({ variant: 'section' });
    expect(Array.isArray(ui.rateLimits['ui:grid-layout'])).toBe(true);
  });

  it('groups related fields onto shared grid rows', () => {
    const ui: any = AiProviderEditForm.uiSchema;
    const rows: Array<Record<string, unknown>> = ui['ui:grid-layout'];
    const rowFor = (field: string) => rows.find((row) => Object.prototype.hasOwnProperty.call(row, field));

    // Identity fields share a row; connection fields share a row.
    expect(rowFor('id')).toBe(rowFor('name'));
    expect(rowFor('endpointUrl')).toBe(rowFor('apiVersion'));
    expect(rowFor('capabilities')).toBe(rowFor('roles'));
  });

  it('locks the provider id in edit mode and requires it when creating', () => {
    const editId = (AiProviderEditForm.schema as any).properties.id;
    const createId = (AiProviderCreateForm.schema as any).properties.id;

    expect(editId.readOnly).toBe(true);
    expect(createId.readOnly).toBe(false);
    expect((AiProviderEditForm.schema as any).required).toEqual(['name']);
    expect((AiProviderCreateForm.schema as any).required).toEqual(['id', 'name']);
  });
});
