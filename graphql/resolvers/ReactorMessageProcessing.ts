import { mutation, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";

@resolver
class ReactorMessageProcessingResolver {
  resolver: any;

  @mutation("ReactorSendGenericRequest")
  async ReactorSendGenericRequest(_: any, args: {
    template: any,
    parameters: any,
    chatSessionId?: string
  }, context: Reactory.Server.IReactoryContext) {
    const messageProcessingService = context.getService("reactor.ReactorMessageProcessingService@1.0.0");
    return messageProcessingService.processGenericRequest(
      args.template,
      args.parameters,
      args.chatSessionId
    );
  }
}

export default ReactorMessageProcessingResolver;
