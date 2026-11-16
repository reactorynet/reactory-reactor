import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Move the seeded Google provider off `apiVersion: v1`.
 *
 * WHY
 *
 * `providers.yaml` declared `apiVersion: v1` for the google provider, and
 * `seedAiProviders(..., overwrite = false)` wrote that value into
 * `reactory_ai_providers` when the table was first seeded. Nothing forwarded it:
 * `@google/genai` 1.24.0 defaults to `v1beta` and `GoogleAIService` passed no
 * `apiVersion`, so every request actually went to `/v1beta/`.
 *
 * That makes the stored `v1` inert. It became harmful only once 3.1.0 changed its own
 * default to `v1`: from that point the provider started forwarding the registry value,
 * so an installation seeded before this change would silently move every Gemini call
 * to `/v1/` — dropping the v1beta-only features (live, audio output, explicit context
 * caching, agents) without any code change or failing test.
 *
 * SCOPE — deliberately narrow
 *
 * Only rows that still hold the seeded value are touched:
 *   - `id = 'google'`                the bundled provider
 *   - `apiVersion = 'v1'`            the seeded value; an operator's own choice is left alone
 *
 * A row already on `v1beta`, `v1alpha`, NULL or anything else is untouched, so an
 * operator who deliberately set `v1` through `updateProvider` before this migration
 * has their choice preserved... except that we cannot distinguish "seeded" from
 * "deliberately set to v1" by data alone. The timestamp test below closes that gap:
 * a row is only rewritten when it has not been updated since it was created, which is
 * the signature of a seeded row that no admin has ever edited.
 *
 * New installs are seeded from `providers.yaml`, which now declares
 * `apiVersion: "${GOOGLE_AI_API_VERSION:-v1beta}"`, so they never see `v1` at all and
 * this migration is a no-op for them.
 *
 * DOWN
 *
 * Restores the old stored value so the migration is reversible. Reverting does not
 * restore the old wire behaviour — after this change the value is forwarded — so a
 * rollback must be paired with reverting the code, not run alone.
 */
export class SetGoogleProviderApiVersionV1Beta20261116120000 implements MigrationInterface {
  name = "SetGoogleProviderApiVersionV1Beta20261116120000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE reactory_ai_providers
          SET "apiVersion" = 'v1beta'
        WHERE id = 'google'
          AND "apiVersion" = 'v1'
          AND "updatedAt" = "createdAt"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE reactory_ai_providers
          SET "apiVersion" = 'v1'
        WHERE id = 'google'
          AND "apiVersion" = 'v1beta'
          AND "updatedAt" = "createdAt"`,
    );
  }
}
