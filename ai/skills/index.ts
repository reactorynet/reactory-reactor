import { ISkillDefinition } from '../openai/types/chat';

export const ReactorSkills: ISkillDefinition[] = [
  {
    id: 'reactory.queryingDataAndVisualizing@1.0.0',
    name: 'queryingDataAndVisualizing',
    nameSpace: 'reactory',
    version: '1.0.0',
    description:
      'Guides agents through connection discovery, count-first querying, large dataset export, and chart/D3 visualization workflows for data analysis.',
    filePath: require.resolve('./data-analysis/querying-data-and-visualizing.md'),
    tags: ['data-analysis', 'sql', 'mongo', 'visualization', 'chart', 'd3'],
    roles: ['USER', 'DEVELOPER', 'ADMIN'],
    examples: [
      '@searchSkills(query: "data analysis")',
      '@readSkill(id: "reactory.queryingDataAndVisualizing@1.0.0")',
    ],
  },
];

export default ReactorSkills;