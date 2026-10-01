import AiModelsGridForm from '../aiModels';
import { ModelTableUIOptions } from '../aiModels/uiSchema';
import AiModelEditForm from '../aiModels/edit';
import AiModelCreateForm from '../aiModels/create';
import ReactorForms from '../index';

/**
 * Guards the AI Models admin form wiring.
 *
 * The grid previously referenced `reactor.AiModelWorkflow@1.0.0` for its
 * add/delete buttons but that component did not exist, so both buttons were
 * inert. These tests assert that every FQN the grid resolves at runtime is
 * actually shipped in the form's `modules` bundle.
 */
describe('AI model forms', () => {
  const moduleIds = (AiModelsGridForm.modules || []).map((m: any) => m.id);

  it('bundles the workflow, detail panel and toolbar client modules', () => {
    expect(moduleIds).toEqual(
      expect.arrayContaining([
        'reactor.AiModelWorkflow@1.0.0',
        'reactor.AiModelDetailPanel@1.0.0',
        'reactor.AiModelsToolbar@1.0.0',
      ])
    );

    (AiModelsGridForm.modules || []).forEach((module: any) => {
      expect(typeof module.src).toBe('string');
      expect(module.src.length).toBeGreaterThan(0);
    });
  });

  it('wires the detail panel and toolbar through componentMap', () => {
    expect(ModelTableUIOptions.componentMap).toEqual({
      DetailsPanel: 'reactor.AiModelDetailPanel@1.0.0',
      Toolbar: 'reactor.AiModelsToolbar@1.0.0',
    });
  });

  it('maps the expanded row onto the panel `model` prop', () => {
    expect(ModelTableUIOptions.detailPanelPropsMap).toEqual({ 'props.rowData': 'model' });
  });

  it('refreshes the grid when the models workflow publishes a change', () => {
    expect(ModelTableUIOptions.refreshEvents).toEqual([{ name: 'reactor.AiModelChanged' }]);
  });

  it('only references components that are bundled with the form', () => {
    const referenced: string[] = [
      ModelTableUIOptions.addButtonProps?.onClick,
      ModelTableUIOptions.deleteButtonProps?.onClick,
      ModelTableUIOptions.componentMap?.DetailsPanel,
      ModelTableUIOptions.componentMap?.Toolbar,
    ].filter((value): value is string => typeof value === 'string');

    expect(referenced.length).toBeGreaterThan(0);

    referenced.forEach((reference) => {
      const componentFqn = reference.includes('/') ? reference.split('/')[0] : reference;
      expect(moduleIds).toContain(componentFqn);
    });
  });

  it('registers create and edit editor forms', () => {
    const ids = (ReactorForms as any[]).map((form) => form.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'reactor.AiModelsGrid@1.0.0',
        'reactor.AiModelEdit@1.0.0',
        'reactor.AiModelCreate@1.0.0',
      ])
    );
  });

  it('lays the model editor out on the 12-column grid', () => {
    const ui: any = AiModelEditForm.uiSchema;
    expect(ui['ui:field']).toBe('TabbedLayout');
    expect(Array.isArray(ui['ui:grid-layout'])).toBe(true);
    expect(ui['ui:grid-layout'].length).toBeGreaterThan(0);
  });

  it('groups the model editor fields into tabs', () => {
    const ui: any = AiModelEditForm.uiSchema;
    const layout: Array<{ title?: string; fields?: string[] }> = ui['ui:tab-layout'];

    expect(ui['ui:field']).toBe('TabbedLayout');
    expect(layout.map((tab) => tab.title)).toEqual([
      'Identity',
      'Limits',
      'Capabilities',
      'Cost',
      'Advanced',
    ]);

    const schemaProperties = Object.keys((AiModelEditForm.schema as any).properties);
    const tabFields = layout.flatMap((tab) => tab.fields ?? []);
    tabFields.forEach((field) => expect(schemaProperties).toContain(field));

    // No field is left out of the tabs.
    expect(new Set(tabFields)).toEqual(new Set(schemaProperties));
  });

  it('renders sampling and thinking as padded sections with their own grids', () => {
    const ui: any = AiModelEditForm.uiSchema;

    expect(ui.sampling['ui:options']).toEqual({ variant: 'section' });
    expect(Array.isArray(ui.sampling['ui:grid-layout'])).toBe(true);

    expect(ui.thinking['ui:options']).toEqual({ variant: 'section' });
    expect(Array.isArray(ui.thinking['ui:grid-layout'])).toBe(true);
  });

  it('groups related fields onto shared grid rows', () => {
    const ui: any = AiModelEditForm.uiSchema;
    const rows: Array<Record<string, unknown>> = ui['ui:grid-layout'];
    const rowFor = (field: string) => rows.find((row) => Object.prototype.hasOwnProperty.call(row, field));

    expect(rowFor('providerId')).toBe(rowFor('modelKey'));
    expect(rowFor('supportsStreaming')).toBe(rowFor('isEnabled'));
    expect(rowFor('inputCostPerTokenUsdCents')).toBe(rowFor('outputCostPerTokenUsdCents'));
  });

  it('locks the model identity in edit mode and requires it when creating', () => {
    const editProperties = (AiModelEditForm.schema as any).properties;
    const createProperties = (AiModelCreateForm.schema as any).properties;

    expect(editProperties.providerId.readOnly).toBe(true);
    expect(editProperties.modelKey.readOnly).toBe(true);
    expect(createProperties.providerId.readOnly).toBe(false);
    expect(createProperties.modelKey.readOnly).toBe(false);

    expect((AiModelEditForm.schema as any).required).toEqual(['name']);
    expect((AiModelCreateForm.schema as any).required).toEqual(['providerId', 'modelKey', 'name']);
  });
});
