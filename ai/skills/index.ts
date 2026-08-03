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
  {
    id: 'reactory.analyzeLogs@1.0.0',
    name: 'analyzeLogs',
    nameSpace: 'reactory',
    version: '1.0.0',
    description:
      'Guides agents on how to effectively search, parse, and analyze JSON log files in the Reactory environment while preserving token context limits.',
    filePath: require.resolve('./log-analysis/analyze-logs.md'),
    tags: ['logs', 'analysis', 'debugging', 'troubleshooting', 'jq', 'grep'],
    roles: ['USER', 'DEVELOPER', 'ADMIN'],
    examples: [
      '@searchSkills(query: "logs")',
      '@readSkill(id: "reactory.analyzeLogs@1.0.0")',
    ],
  },
  {
    id: 'reactory.graphCatalogWalkAndLink@1.0.0',
    name: 'graphCatalogWalkAndLink',
    nameSpace: 'reactory',
    version: '1.0.0',
    description:
      'Guides agents through the Reactor system graph tools: cataloging a project, walking nodes and edges (searchGraph, graphChildren, exploreGraph, graphLinks), analyzing the underlying content, and creating edges with createNodeEdge only for relationships confirmed by concrete evidence.',
    filePath: require.resolve('./graph-exploration/catalog-walk-and-link.md'),
    tags: ['graph', 'catalog', 'traversal', 'edges', 'linking', 'reactor', 'analysis'],
    roles: ['USER', 'DEVELOPER', 'ADMIN'],
    examples: [
      '@searchSkills(query: "graph")',
      '@readSkill(id: "reactory.graphCatalogWalkAndLink@1.0.0")',
    ],
  },
];

export default ReactorSkills;
