import { describe, it, expect } from '@jest/globals';
import { ProviderTableUIOptions } from '../aiProviders/uiSchema';
import { ModelTableUIOptions } from '../aiModels/uiSchema';

/**
 * The AI providers and models grids bold the record name against its id:
 *
 *     <strong>OpenAI</strong> (openai)
 *
 * That markup lives in the column's `ui:options.format`, and the column is bound
 * to `core.LabelComponent@1.0.0`. The label widget renders its computed value
 * through the shared content renderer, which sanitizes the HTML and renders it
 * inline — so the name is bold and the tags are not visible.
 *
 * These tests pin the *server-side* half of that contract. The rendering itself
 * is covered by the client tests (`LabelWidget.html.test.tsx`). What matters
 * here is that the format keeps producing markup and keeps being bound to a
 * component that can render it: if someone switches this column to a plain
 * component — or drops the tags from the format — the label silently degrades
 * again, and only this assertion would notice.
 */
describe('AI grid column labels', () => {
  const columnByTitle = (options: any, title: string) =>
    (options?.columns ?? []).find((column: any) => column.title === title);

  const formatOf = (options: any, title: string) =>
    columnByTitle(options, title)?.props?.uiSchema?.['ui:options']?.format;

  const NAME_FORMAT = '<strong>${rowData.name}</strong> (${rowData.id})';

  describe('AI providers grid', () => {
    it('bolds the provider name against its id', () => {
      expect(formatOf(ProviderTableUIOptions, 'Name')).toBe(NAME_FORMAT);
    });

    it('binds the name column to a content-rendering component', () => {
      expect(columnByTitle(ProviderTableUIOptions, 'Name')?.component).toBe(
        'core.LabelComponent@1.0.0'
      );
    });
  });

  describe('AI models grid', () => {
    it('bolds the model name against its id', () => {
      expect(formatOf(ModelTableUIOptions, 'Model')).toBe(NAME_FORMAT);
    });

    it('binds the model column to a content-rendering component', () => {
      expect(columnByTitle(ModelTableUIOptions, 'Model')?.component).toBe(
        'core.LabelComponent@1.0.0'
      );
    });
  });

  describe('every column', () => {
    /**
     * A column without a component falls back to `cellText`, which renders the
     * raw string — so markup in such a column would be displayed verbatim. Any
     * column carrying tags must therefore be component-bound.
     */
    it('binds any column whose format contains markup', () => {
      const offenders: string[] = [];

      [ProviderTableUIOptions, ModelTableUIOptions].forEach((options: any) => {
        (options?.columns ?? []).forEach((column: any) => {
          const format = column?.props?.uiSchema?.['ui:options']?.format;
          if (typeof format === 'string' && /<[a-z][a-z0-9]*\b[^>]*>/i.test(format)) {
            if (!column.component) offenders.push(column.title);
          }
        });
      });

      expect(offenders).toEqual([]);
    });
  });
});
