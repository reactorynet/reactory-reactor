/**
 * Mock data generator for Reactor System Graph visualization
 * Represents enterprise architecture as a cosmic hierarchy:
 * Universe > Galaxy > System > Project > Environment > Cluster > Pod/Resource
 */

export interface ReactorNode {
  id: string;
  name: string;
  type: 'universe' | 'galaxy' | 'system' | 'project' | 'environment' | 'cluster' | 'pod' | 'resource';
  parentId?: string;
  status: string;
  description?: string;
  version?: string;
  namespace?: string;
  metadata: {
    size: number; // Visual size multiplier
    color: string; // Base color
    orbitRadius?: number; // Distance from parent
    orbitSpeed?: number; // Orbital speed
    mass?: number; // For gravitational effects
  };
  links: Array<{
    targetId: string;
    strength: number; // 0-1, determines orbital closeness
    type: 'contains' | 'connects' | 'depends';
  }>;
  children?: ReactorNode[];
}

// Status color mapping
const statusColors = {
  RUNNING: '#00ff00',
  STABLE: '#00aa00', 
  PENDING: '#ffaa00',
  UNSTABLE: '#ff6600',
  FAILED: '#ff0000',
  DEPRECATED: '#666666',
  ARCHIVED: '#333333',
  ACTIVE: '#0088ff',
  INACTIVE: '#004488'
};

// Generate mock Reactor system data
export function generateMockReactorData(): ReactorNode[] {
  // Universe level
  const universe: ReactorNode = {
    id: 'universe-1',
    name: 'Enterprise Cloud Universe',
    type: 'universe',
    status: 'ACTIVE',
    description: 'Complete enterprise cloud infrastructure',
    version: '2.1.0',
    namespace: 'enterprise',
    metadata: {
      size: 8.0,
      color: '#4a148c', // Deep purple for universe
      mass: 1000
    },
    links: [],
    children: []
  };

  // Galaxy level (business domains)
  const galaxies: ReactorNode[] = [
    {
      id: 'galaxy-1',
      name: 'Finance Galaxy',
      type: 'galaxy',
      parentId: 'universe-1',
      status: 'STABLE',
      description: 'Financial services and payment systems',
      version: '1.8.2',
      namespace: 'finance',
      metadata: {
        size: 6.0,
        color: '#1a237e', // Deep blue
        orbitRadius: 150,
        orbitSpeed: 0.002,
        mass: 500
      },
      links: [
        { targetId: 'universe-1', strength: 0.9, type: 'contains' }
      ],
      children: []
    },
    {
      id: 'galaxy-2', 
      name: 'Customer Galaxy',
      type: 'galaxy',
      parentId: 'universe-1',
      status: 'STABLE',
      description: 'Customer management and CRM systems',
      version: '2.0.1',
      namespace: 'customer',
      metadata: {
        size: 5.5,
        color: '#0d47a1', // Blue
        orbitRadius: 120,
        orbitSpeed: 0.0025,
        mass: 450
      },
      links: [
        { targetId: 'universe-1', strength: 0.8, type: 'contains' },
        { targetId: 'galaxy-1', strength: 0.3, type: 'connects' }
      ],
      children: []
    },
    {
      id: 'galaxy-3',
      name: 'Engineering Galaxy', 
      type: 'galaxy',
      parentId: 'universe-1',
      status: 'ACTIVE',
      description: 'Development and engineering tools',
      version: '3.1.0',
      namespace: 'engineering',
      metadata: {
        size: 4.8,
        color: '#01579b', // Light blue
        orbitRadius: 100,
        orbitSpeed: 0.003,
        mass: 400
      },
      links: [
        { targetId: 'universe-1', strength: 0.7, type: 'contains' },
        { targetId: 'galaxy-1', strength: 0.2, type: 'connects' },
        { targetId: 'galaxy-2', strength: 0.4, type: 'connects' }
      ],
      children: []
    }
  ];

  // System level (major applications)
  const systems: ReactorNode[] = [
    // Finance Galaxy Systems
    {
      id: 'system-1',
      name: 'Payment Processing System',
      type: 'system',
      parentId: 'galaxy-1',
      status: 'RUNNING',
      description: 'Core payment processing infrastructure',
      version: '4.2.1',
      namespace: 'finance-payments',
      metadata: {
        size: 3.5,
        color: '#ffd600', // Gold for payment system
        orbitRadius: 40,
        orbitSpeed: 0.01,
        mass: 200
      },
      links: [
        { targetId: 'galaxy-1', strength: 0.9, type: 'contains' }
      ],
      children: []
    },
    {
      id: 'system-2',
      name: 'Risk Management System',
      type: 'system', 
      parentId: 'galaxy-1',
      status: 'STABLE',
      description: 'Financial risk assessment and monitoring',
      version: '2.8.0',
      namespace: 'finance-risk',
      metadata: {
        size: 2.8,
        color: '#ff6f00', // Orange
        orbitRadius: 32,
        orbitSpeed: 0.012,
        mass: 150
      },
      links: [
        { targetId: 'galaxy-1', strength: 0.8, type: 'contains' },
        { targetId: 'system-1', strength: 0.6, type: 'connects' }
      ],
      children: []
    },
    // Customer Galaxy Systems
    {
      id: 'system-3',
      name: 'CRM Platform',
      type: 'system',
      parentId: 'galaxy-2',
      status: 'RUNNING',
      description: 'Customer relationship management platform',
      version: '5.1.2',
      namespace: 'customer-crm',
      metadata: {
        size: 3.2,
        color: '#2e7d32', // Green
        orbitRadius: 35,
        orbitSpeed: 0.008,
        mass: 180
      },
      links: [
        { targetId: 'galaxy-2', strength: 0.9, type: 'contains' },
        { targetId: 'system-1', strength: 0.3, type: 'connects' }
      ],
      children: []
    },
    // Engineering Galaxy Systems
    {
      id: 'system-4',
      name: 'CI/CD Pipeline System',
      type: 'system',
      parentId: 'galaxy-3',
      status: 'ACTIVE',
      description: 'Continuous integration and deployment',
      version: '6.0.1',
      namespace: 'engineering-cicd',
      metadata: {
        size: 2.5,
        color: '#7b1fa2', // Purple
        orbitRadius: 28,
        orbitSpeed: 0.015,
        mass: 120
      },
      links: [
        { targetId: 'galaxy-3', strength: 0.8, type: 'contains' }
      ],
      children: []
    }
  ];

  // Environment level (deployment environments)
  const environments: ReactorNode[] = [
    {
      id: 'env-1',
      name: 'Production Environment',
      type: 'environment',
      parentId: 'system-1',
      status: 'STABLE',
      description: 'Production payment processing',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 1.8,
        color: '#c62828', // Red for production
        orbitRadius: 15,
        orbitSpeed: 0.02,
        mass: 80
      },
      links: [
        { targetId: 'system-1', strength: 0.9, type: 'contains' }
      ],
      children: []
    },
    {
      id: 'env-2', 
      name: 'Staging Environment',
      type: 'environment',
      parentId: 'system-1',
      status: 'STABLE',
      description: 'Pre-production testing',
      namespace: 'finance-payments-staging',
      metadata: {
        size: 1.5,
        color: '#f57c00', // Orange for staging
        orbitRadius: 12,
        orbitSpeed: 0.025,
        mass: 60
      },
      links: [
        { targetId: 'system-1', strength: 0.7, type: 'contains' },
        { targetId: 'env-1', strength: 0.4, type: 'connects' }
      ],
      children: []
    },
    {
      id: 'env-3',
      name: 'Development Environment',
      type: 'environment', 
      parentId: 'system-1',
      status: 'ACTIVE',
      description: 'Development and testing',
      namespace: 'finance-payments-dev',
      metadata: {
        size: 1.2,
        color: '#388e3c', // Green for development
        orbitRadius: 10,
        orbitSpeed: 0.03,
        mass: 40
      },
      links: [
        { targetId: 'system-1', strength: 0.6, type: 'contains' },
        { targetId: 'env-2', strength: 0.5, type: 'connects' }
      ],
      children: []
    }
  ];

  // Cluster level (infrastructure clusters)
  const clusters: ReactorNode[] = [
    {
      id: 'cluster-1',
      name: 'Payment API Cluster',
      type: 'cluster',
      parentId: 'env-1',
      status: 'RUNNING',
      description: 'API gateway cluster for payments',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 0.8,
        color: '#1976d2', // Blue for clusters
        orbitRadius: 6,
        orbitSpeed: 0.04,
        mass: 25
      },
      links: [
        { targetId: 'env-1', strength: 0.8, type: 'contains' }
      ],
      children: []
    },
    {
      id: 'cluster-2',
      name: 'Database Cluster',
      type: 'cluster',
      parentId: 'env-1', 
      status: 'RUNNING',
      description: 'Primary database cluster',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 0.9,
        color: '#303f9f', // Darker blue
        orbitRadius: 7,
        orbitSpeed: 0.035,
        mass: 30
      },
      links: [
        { targetId: 'env-1', strength: 0.9, type: 'contains' },
        { targetId: 'cluster-1', strength: 0.7, type: 'connects' }
      ],
      children: []
    }
  ];

  // Pod level (individual services)
  const pods: ReactorNode[] = [
    {
      id: 'pod-1',
      name: 'payment-api-1',
      type: 'pod',
      parentId: 'cluster-1',
      status: 'RUNNING',
      description: 'Payment API instance 1',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 0.3,
        color: '#4fc3f7', // Light blue for pods
        orbitRadius: 2.5,
        orbitSpeed: 0.08,
        mass: 5
      },
      links: [
        { targetId: 'cluster-1', strength: 0.8, type: 'contains' }
      ],
      children: []
    },
    {
      id: 'pod-2',
      name: 'payment-api-2', 
      type: 'pod',
      parentId: 'cluster-1',
      status: 'RUNNING',
      description: 'Payment API instance 2',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 0.3,
        color: '#4fc3f7',
        orbitRadius: 3,
        orbitSpeed: 0.06,
        mass: 5
      },
      links: [
        { targetId: 'cluster-1', strength: 0.8, type: 'contains' },
        { targetId: 'pod-1', strength: 0.3, type: 'connects' }
      ],
      children: []
    },
    {
      id: 'pod-3',
      name: 'postgres-primary',
      type: 'pod',
      parentId: 'cluster-2',
      status: 'RUNNING', 
      description: 'Primary PostgreSQL database',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 0.4,
        color: '#29b6f6', // Slightly different blue
        orbitRadius: 2.8,
        orbitSpeed: 0.07,
        mass: 8
      },
      links: [
        { targetId: 'cluster-2', strength: 0.9, type: 'contains' },
        { targetId: 'pod-1', strength: 0.6, type: 'connects' },
        { targetId: 'pod-2', strength: 0.6, type: 'connects' }
      ],
      children: []
    }
  ];

  // Resource level (specific resources)
  const resources: ReactorNode[] = [
    {
      id: 'resource-1',
      name: 'Payment Config',
      type: 'resource',
      parentId: 'pod-1',
      status: 'ACTIVE',
      description: 'Payment service configuration',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 0.15,
        color: '#81c784', // Light green for resources
        orbitRadius: 1,
        orbitSpeed: 0.15,
        mass: 1
      },
      links: [
        { targetId: 'pod-1', strength: 0.7, type: 'contains' }
      ],
      children: []
    },
    {
      id: 'resource-2',
      name: 'SSL Certificate',
      type: 'resource',
      parentId: 'pod-1',
      status: 'ACTIVE',
      description: 'TLS certificate for API',
      namespace: 'finance-payments-prod',
      metadata: {
        size: 0.12,
        color: '#a5d6a7', // Lighter green
        orbitRadius: 1.2,
        orbitSpeed: 0.12,
        mass: 1
      },
      links: [
        { targetId: 'pod-1', strength: 0.6, type: 'contains' },
        { targetId: 'resource-1', strength: 0.2, type: 'connects' }
      ],
      children: []
    }
  ];

  // Build hierarchy by assigning children
  const allNodes = [universe, ...galaxies, ...systems, ...environments, ...clusters, ...pods, ...resources];
  
  // Assign children to parents
  allNodes.forEach(node => {
    node.children = allNodes.filter(child => child.parentId === node.id);
  });

  return allNodes;
}

// Utility function to get nodes by level for zoom functionality
export function getNodesByLevel(nodes: ReactorNode[], level: string): ReactorNode[] {
  return nodes.filter(node => node.type === level);
}

// Utility function to get a specific node and its immediate children
export function getNodeWithChildren(nodes: ReactorNode[], nodeId: string): ReactorNode | null {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return null;
  
  node.children = nodes.filter(child => child.parentId === nodeId);
  return node;
}

// Utility function to get hierarchy path from universe to specific node
export function getNodePath(nodes: ReactorNode[], nodeId: string): ReactorNode[] {
  const path: ReactorNode[] = [];
  let currentNode = nodes.find(n => n.id === nodeId);
  
  while (currentNode) {
    path.unshift(currentNode);
    currentNode = currentNode.parentId ? nodes.find(n => n.id === currentNode.parentId) : null;
  }
  
  return path;
}

// Export for use in components
export const mockReactorData = generateMockReactorData();
