import fs from "fs";
import path from "path";

describe("ReactorConversationService.getConversations sub-process filter", () => {
  it("contains the parentSessionId exclusion filter in source", () => {
    const file = path.join(
      __dirname,
      "..",
      "ReactorConversationService.ts"
    );
    const src = fs.readFileSync(file, "utf8");
    expect(src).toMatch(/parentSessionId\s*=\s*\{\s*\$in:\s*\[null,\s*undefined\]\s*\}/);
  });
});