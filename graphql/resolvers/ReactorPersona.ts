import { query, resolver, property } from "@reactory/server-core/models/graphql/decorators/resolver";
import AIPersonaProvider from "@reactory/server-core/modules/reactory-reactor/services/reactor/AIPersonaProvider";
import { IAIPersona } from "@reactory/server-core/modules/reactory-reactor/types/service.types";
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

    const personaId = persona.id?.toLowerCase().replace("aipersona", "");
    const baseDir = path.join(process.env.APP_DATA_ROOT, 'profiles/reactor/personas/', personaId);
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
