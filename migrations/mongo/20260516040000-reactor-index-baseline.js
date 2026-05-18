// Reactory Reactor Mongo index baseline migration.
//
// WHY: Ensure core reactor query paths are backed by explicit indexes in
// environments where model auto-indexing may be disabled.

const COLLECTIONS = {
  conversations: "reactor_conversations",
  projects: "reactor_projects",
  mcpRegistries: "mcpregistries",
  mcpInstalledConnectors: "mcpinstalledconnectors",
};

const keyEquals = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const findIndexByKey = (indexes, key) => indexes.find((idx) => keyEquals(idx.key, key));

const ensureIndex = async (col, indexes, key, options = {}) => {
  const existing = findIndexByKey(indexes, key);

  if (existing) {
    if (options.unique === true && existing.unique !== true) {
      throw new Error(
        `Conflicting index on ${col.collectionName} ${JSON.stringify(key)}: expected unique=true.`
      );
    }

    if (
      Object.prototype.hasOwnProperty.call(options, "partialFilterExpression")
      && !keyEquals(existing.partialFilterExpression || {}, options.partialFilterExpression || {})
    ) {
      throw new Error(
        `Conflicting partialFilterExpression on ${col.collectionName} ${JSON.stringify(key)}.`
      );
    }

    return;
  }

  await col.createIndex(key, options);
  indexes.push({ key, ...options });
};

module.exports = {
  /**
   * @param {import('mongodb').Db} db
   */
  async up(db) {
    // reactor_conversations
    {
      const col = db.collection(COLLECTIONS.conversations);
      const indexes = await col.indexes();

      // Already declared in schema, but enforced explicitly for production parity.
      await ensureIndex(
        col,
        indexes,
        { personaId: 1, user: 1, started: 1 },
        {
          name: "personaId_1_user_1_started_1",
          unique: true,
          background: true,
          partialFilterExpression: {
            started: { $exists: true },
            personaId: { $exists: true },
            user: { $exists: true },
          },
        }
      );

      await ensureIndex(
        col,
        indexes,
        { parentSessionId: 1 },
        { name: "parentSessionId_1", background: true }
      );

      await ensureIndex(
        col,
        indexes,
        { user: 1, updated: -1 },
        { name: "user_1_updated_-1", background: true }
      );

      await ensureIndex(
        col,
        indexes,
        { user: 1, personaId: 1, updated: -1 },
        { name: "user_1_personaId_1_updated_-1", background: true }
      );

      await ensureIndex(
        col,
        indexes,
        { user: 1, modelId: 1, updated: -1 },
        { name: "user_1_modelId_1_updated_-1", background: true }
      );
    }

    // reactor_projects
    {
      const col = db.collection(COLLECTIONS.projects);
      const indexes = await col.indexes();

      await ensureIndex(col, indexes, { fqn: 1 }, { name: "fqn_1", background: true });
      await ensureIndex(col, indexes, { name: 1 }, { name: "name_1", background: true });
      await ensureIndex(col, indexes, { repoPath: 1 }, { name: "repoPath_1", background: true });

      await ensureIndex(col, indexes, { client: 1 }, { name: "client_1", background: true });
      await ensureIndex(
        col,
        indexes,
        { organization: 1 },
        { name: "organization_1", background: true }
      );
      await ensureIndex(
        col,
        indexes,
        { businessUnit: 1 },
        { name: "businessUnit_1", background: true }
      );
      await ensureIndex(col, indexes, { ownerTeam: 1 }, { name: "ownerTeam_1", background: true });
      await ensureIndex(col, indexes, { owner: 1 }, { name: "owner_1", background: true });
      await ensureIndex(col, indexes, { status: 1 }, { name: "status_1", background: true });

      await ensureIndex(col, indexes, { tags: 1 }, { name: "tags_1", background: true });
      await ensureIndex(
        col,
        indexes,
        { projectTypes: 1 },
        { name: "projectTypes_1", background: true }
      );

      await ensureIndex(
        col,
        indexes,
        { businessUnit: 1, ownerTeam: 1, owner: 1, status: 1 },
        { name: "businessUnit_1_ownerTeam_1_owner_1_status_1", background: true }
      );
    }

    // mcpregistries
    {
      const col = db.collection(COLLECTIONS.mcpRegistries);
      const indexes = await col.indexes();

      await ensureIndex(col, indexes, { enabled: 1 }, { name: "enabled_1", background: true });
      await ensureIndex(col, indexes, { type: 1, name: 1 }, { name: "type_1_name_1", background: true });
    }

    // mcpinstalledconnectors
    {
      const col = db.collection(COLLECTIONS.mcpInstalledConnectors);
      const indexes = await col.indexes();

      await ensureIndex(col, indexes, { registryId: 1 }, { name: "registryId_1", background: true });
      await ensureIndex(
        col,
        indexes,
        { organizationId: 1, status: 1 },
        { name: "organizationId_1_status_1", background: true }
      );
      await ensureIndex(col, indexes, { name: 1 }, { name: "name_1", background: true });
    }
  },

  /**
   * @param {import('mongodb').Db} db
   */
  async down(db) {
    // Forward-only baseline: intentionally do not remove indexes.
  },
};