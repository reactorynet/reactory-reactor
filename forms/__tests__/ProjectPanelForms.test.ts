import ReactorProjectsInfoPanel from '../projectInfoPanel';
import ReactorProjectsMetricsPanel from '../projectMetrics';

/**
 * Guards the project dashboard panels' grid layout.
 *
 * `ui:grid-layout` is the render list: a schema property the layout does not
 * name is not rendered (legacy `MaterialGridField` and, since
 * REACTORY-302016408/20261014/2327145804, the v5 object template both work this
 * way). These panels configured a widget for every metric but the layout named
 * only twelve of the fourteen, so `closedPullRequests` and `activeDeployments`
 * silently never appeared. The second test states the invariant so the next
 * metric that is added cannot repeat the omission.
 */
describe('project dashboard panels', () => {
  const panels: Array<[string, any]> = [
    ['projectInfoPanel', ReactorProjectsInfoPanel],
    ['projectMetrics', ReactorProjectsMetricsPanel],
  ];

  const declaredProperties = (form: any): Set<string> => {
    const rows: Array<Record<string, unknown>> = form.uiSchema['ui:grid-layout'] as any;
    const declared = new Set<string>();
    rows.forEach((row) => Object.keys(row).forEach((key) => declared.add(key.split('.')[0])));
    return declared;
  };

  const boundWidgets = (form: any): string[] =>
    Object.entries((form.schema as any).properties as Record<string, any>)
      .filter(([name]) => {
        const fieldUi = form.uiSchema[name];
        const widget = fieldUi && typeof fieldUi === 'object' ? fieldUi['ui:widget'] : undefined;
        // A hidden field is intentionally not rendered, so it needs no slot.
        return typeof widget === 'string' && widget.length > 0 && widget !== 'hidden' && widget !== 'HiddenWidget';
      })
      .map(([name]) => name);

  it.each(panels)('%s declares the previously omitted metrics in its layout', (_label, form) => {
    const declared = declaredProperties(form);

    expect(declared).toContain('closedPullRequests');
    expect(declared).toContain('activeDeployments');
  });

  it.each(panels)('%s gives every widget-bound property a layout slot', (_label, form) => {
    const declared = declaredProperties(form);
    const missing = boundWidgets(form).filter((name) => !declared.has(name));

    expect(missing).toEqual([]);
  });

  it.each(panels)('%s keeps the panels laid out three-up on desktop', (_label, form) => {
    const rows: Array<Record<string, any>> = form.uiSchema['ui:grid-layout'] as any;
    const closedPullRequests = rows
      .map((row) => row.closedPullRequests)
      .find((size) => size !== undefined);

    expect(closedPullRequests).toEqual({ xs: 12, sm: 12, md: 4, lg: 4, xl: 4 });
  });
});
