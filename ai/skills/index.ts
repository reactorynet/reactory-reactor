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
  {
    id: 'reactory.remoteDeployment@1.0.0',
    name: 'remoteDeployment',
    nameSpace: 'reactory',
    version: '1.0.0',
    description:
      'Guides agents through remote host SSH configuration, keypair generation, podman deployment automation, i18n & form widget asset packaging, and container diagnostic workflows.',
    filePath: require.resolve('./reactory-deployment/remote-deployment.md'),
    tags: ['deployment', 'ssh', 'podman', 'containers', 'remote-host', 'debugging', 'i18n', 'plugins', 'devops'],
    roles: ['USER', 'DEVELOPER', 'ADMIN'],
    examples: [
      '@searchSkills(query: "deployment")',
      '@readSkill(id: "reactory.remoteDeployment@1.0.0")',
    ],
  },
  {
    id: 'reactory.kubernetesDeployment@1.0.0',
    name: 'kubernetesDeployment',
    nameSpace: 'reactory',
    version: '1.0.0',
    description:
      'Comprehensive methodology, toolchain, and operational workflows for deploying, diagnosing, hot-patching, and managing Reactory workloads on Kubernetes and GitOps engines (ArgoCD).',
    filePath: require.resolve('./reactory-deployment/k8s-deployment.md'),
    tags: ['kubernetes', 'k8s', 'terraform', 'gitops', 'argocd', 'deployment', 'ingress', 'containermgmt', 'devops'],
    roles: ['USER', 'DEVELOPER', 'ADMIN'],
    examples: [
      '@searchSkills(query: "kubernetes")',
      '@searchSkills(query: "k8s")',
      '@readSkill(id: "reactory.kubernetesDeployment@1.0.0")',
    ],
  },
  {
    id: 'reactory.temporalWorkflowBridge@1.0.0',
    name: 'temporalWorkflowBridge',
    nameSpace: 'reactory',
    version: '1.0.0',
    description:
      'Decides when durable execution on Temporal is warranted versus the Reactory workflow engine, and shows how to bridge them: the temporal_* step inventory, await modes (durable event suspend vs polling), the settled-event contract and its lost-wakeup/tenancy hazards, human approval gates via user_activity tasks, and a diagnostic order for a workflow stuck waiting.',
    filePath: require.resolve('./temporal-integration/durable-workflow-bridge.md'),
    tags: [
      'temporal',
      'workflow',
      'durable-execution',
      'yaml-workflow',
      'saga',
      'approval',
      'human-in-the-loop',
      'signals',
      'orchestration',
      'troubleshooting',
    ],
    roles: ['USER', 'DEVELOPER', 'ADMIN'],
    examples: [
      '@searchSkills(query: "temporal")',
      '@searchSkills(query: "durable workflow")',
      '@readSkill(id: "reactory.temporalWorkflowBridge@1.0.0")',
    ],
  },
  {
    id: 'reactory.maestroMobileTesting@1.0.0',
    name: 'maestroMobileTesting',
    nameSpace: 'reactory',
    version: '1.0.0',
    description:
      'Comprehensive guide and operational workflows for driving declarative, cross-platform mobile UI automation and end-to-end regression testing on Android emulators and iOS simulators using Maestro.',
    filePath: require.resolve('./mobile-automation/maestro-testing.md'),
    tags: ['mobile', 'android', 'ios', 'maestro', 'testing', 'automation', 'e2e', 'playwright-mobile', 'emulator', 'simulator'],
    roles: ['USER', 'DEVELOPER', 'ADMIN'],
    examples: [
      '@searchSkills(query: "maestro")',
      '@searchSkills(query: "mobile testing")',
      '@readSkill(id: "reactory.maestroMobileTesting@1.0.0")',
    ],
  },
];

export default ReactorSkills;
