# ReactorSystemGraph GraphQL Schema

This directory contains the modularized GraphQL schema for the Reactor System Graph, which models the structure, relationships, and operational state of projects, nodes, environments, and platform resources in the Reactory platform.

## Overview
The schema is split into logical groups for maintainability and clarity:

- **types.graphql**: Core node types, enums, and node-related structures.
- **project.graphql**: Project, deployment, dashboard, security, and related types.
- **platform.graphql**: Platform-level types such as clusters, pods, resources, and project environments.
- **ui.graphql**: UI and visualization types for nodes and graphs.
- **links.graphql**: Types for node links and relationships.
- **inputs.graphql**: Input types for queries and mutations.
- **mutations.graphql**: Mutation and union types for system graph operations.
- **queries.graphql**: Query extensions for retrieving nodes, projects, and related data.

## What the Schema Provides

- **System Graph Modeling**: Define and query nodes, their types, categories, metrics, and relationships.
- **Project Management**: Model projects, deployments, dashboards, security, and processing history.
- **Platform Insights**: Track clusters, pods, resources, and environments for operational and health insights.
- **Relationships & Links**: Express dependencies, connections, and other relationships between nodes and projects.
- **UI Metadata**: Support for graph visualization, node positioning, and UI options.
- **Extensible Queries & Mutations**: Rich queries for searching, filtering, and browsing the system graph, and mutations for managing nodes, links, and projects.

## Usage
- Import these schema files in your GraphQL server setup to enable the full Reactor System Graph API.
- Extend or customize the schema by adding new types or fields in the appropriate file.
- Use the modular structure to keep domain concerns separated and maintainable.

## Example Use Cases
- Visualizing service dependencies and data flows in a microservices architecture.
- Tracking deployments, environments, and platform health for DevOps and SRE teams.
- Integrating project metadata, documentation, and operational state in a single graph.

---

For more details, see the individual `.graphql` files in this directory.
