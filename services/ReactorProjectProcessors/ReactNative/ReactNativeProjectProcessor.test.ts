import ReactNativeProjectProcessor from "./ReactNativeProjectProcessor";
import { makeContext, writeProject, cleanup } from "../../graph/testUtils";

describe("ReactNativeProjectProcessor", () => {
  const ctx = makeContext();
  const processor = new ReactNativeProjectProcessor({}, ctx);

  it("claims a project only when react-native is a dependency", () => {
    const rn = writeProject({
      "package.json": JSON.stringify({ name: "app", dependencies: { "react-native": "0.73" } }),
    });
    expect(processor.supportsProject(rn.project)).toBe(true);
    expect(processor.getProjectTypes(rn.project)).toEqual(["react-native"]);
    cleanup(rn.dir);

    const plainNode = writeProject({
      "package.json": JSON.stringify({ name: "app", dependencies: { express: "4" } }),
    });
    expect(processor.supportsProject(plainNode.project)).toBe(false);
    cleanup(plainNode.dir);
  });
});
