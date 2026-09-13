import { ChatsMacroRegistry } from "./macro";
import { UpdateChatDataMacroRegistry } from "./updateChatData";

export {
  UpdateChatDataMacro,
  UpdateChatDataMacroRegistry,
  CHAT_STATUS_PALETTE,
} from "./updateChatData";

export default [
  ChatsMacroRegistry,
  UpdateChatDataMacroRegistry,
];