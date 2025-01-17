import { CanedMessages } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { readFileSync } from "fs";

const ReactorCliAppCannedResponses: CanedMessages  = {
  "error": readFileSync(require.resolve("./error.txt")).toString(),
  "welcome": readFileSync(require.resolve("./welcome.txt")).toString(),
  "goodbye": readFileSync(require.resolve("./goodbye.txt")).toString(),
  "help": readFileSync(require.resolve("./help.txt")).toString(),
  "givemeaccess": readFileSync(require.resolve("./givemeaccess.txt")).toString(),
};

export default ReactorCliAppCannedResponses;
