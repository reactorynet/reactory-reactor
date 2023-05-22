import { CanedMessages } from "@reactory/server-modules/reactor/types/chat.types";

const ReactorCliAppCannedResponses: CanedMessages  = {
  "error": require.resolve("./error"),
  "welcome": require.resolve("./welcome"),
};

export default ReactorCliAppCannedResponses;
