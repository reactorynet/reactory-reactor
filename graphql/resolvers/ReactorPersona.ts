import { query, resolver, property } from "@reactory/server-core/models/graphql/decorators/resolver";
import AIPersonaProvider from "@reactory/server-core/modules/reactory-reactor/services/reactor/AIPersonaProvider";
import { IAIPersona } from "@reactory/server-core/modules/reactory-reactor/types/service.types";
import {
  resolveCallingUserId,
  resolveUserAvatarPath,
  toDataRootRelativePath,
} from "@reactory/server-core/modules/reactory-reactor/services/reactor/personaSources";
import path from "path";
import fs from "fs";
import { safeCDNUrl } from '@reactory/server-core/utils/url/safeUrl';

@resolver
class ReactorPersonaResolver {
  resolver: any;

  @query("ReactorPersonas")
  async ReactorPersonas(_: any, __: any, context: Reactory.Server.IReactoryContext): Promise<IAIPersona[]> {
    return context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0").listPersonas();
  }

  @property("ReactorPersona", "avatar")
  async ReactorAIPersonaAvatar(persona: IAIPersona, _: any, context: Reactory.Server.IReactoryContext): Promise<string | null> {
    if (!persona) return null;

    // SEC-6: a personal (profile) persona's avatar lives in the calling user's own folder:
    //   <dataRoot>/profiles/<userId>/reactor/ai/persona/<agent>/avatar.png
    // It is never copied into — or read from — the shared `profiles/reactor/personas/**`
    // namespace, so two users with the same persona id cannot collide or shadow a built-in.
    // The lookup is per calling user, so it also covers a built-in persona that the user has
    // personalised: the personal avatar wins over the shared one.
    const userId = resolveCallingUserId(context);
    if (userId) {
      // A profile-only persona's folder name need not match its id: prefer the layer path the
      // provider recorded on the persona.
      const userLayerPath = Array.isArray(persona.personaSources)
        ? persona.personaSources.find((source) => source?.source === 'user')?.path
        : undefined;
      const userAvatarPath = resolveUserAvatarPath(userId, persona.id, persona.avatar, userLayerPath);
      const relativePath = userAvatarPath ? toDataRootRelativePath(userAvatarPath) : null;
      if (relativePath) return safeCDNUrl(relativePath);
    }
    const personaId = persona.id?.toLowerCase().replace("aipersona", "");
    const dataRoot = process.env.APP_DATA_ROOT || process.env.REACTORY_DATA || '';
    const baseDir = path.join(dataRoot, 'profiles/reactor/personas/', personaId);
    const cdnBase = safeCDNUrl(`profiles/reactor/personas/${personaId}`);

    // If persona.avatar is set, check for its existence
    if (persona.avatar) {
      const customAvatarPath = path.join(baseDir, persona.avatar);
      if (fs.existsSync(customAvatarPath)) {
        return safeCDNUrl(`profiles/reactor/personas/${personaId}/${persona.avatar}`);
      }
    }

    // Fallback to default avatar.png
    const defaultAvatarPath = path.join(baseDir, 'avatar.png');
    if (fs.existsSync(defaultAvatarPath)) {
      return safeCDNUrl(`profiles/reactor/personas/${personaId}/avatar.png`);
    }

    return null;
  }

  @property("ReactorPersona", "personaSources")
  async ReactorAIPersonaSources(persona: IAIPersona): Promise<{ source: string; path: string }[]> {
    if (!Array.isArray(persona.personaSources)) return [];

    // Only expose the layer kind and directory — never anything read out of an untrusted layer.
    return persona.personaSources.map((source) => ({
      source: source?.source || 'module',
      path: source?.path || '',
    }));
  }

  @property("ReactorPersona", "userScoped")
  async ReactorAIPersonaUserScoped(persona: IAIPersona): Promise<boolean> {
    return (persona as any)?.metadata?.userScoped === true;
  }

  @property("ReactorPersona", "tags")
  async ReactorAIPersonaTags(persona: IAIPersona): Promise<string[]> {
    if (Array.isArray(persona.tags) && persona.tags.length > 0) return persona.tags;
    if (Array.isArray((persona as any).metadata?.tags) && (persona as any).metadata.tags.length > 0) {
      return (persona as any).metadata.tags;
    }
    return [];
  }

  @property("ReactorPersona", "toolProfiles")
  async ReactorAIPersonaToolProfiles(persona: IAIPersona): Promise<any[]> {
    if (Array.isArray(persona.toolProfiles) && persona.toolProfiles.length > 0) {
      return persona.toolProfiles;
    }
    return [];
  }

}

export default ReactorPersonaResolver;
