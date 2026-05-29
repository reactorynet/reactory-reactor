import { SearchSkillsRegistry } from "./searchSkills.macro";
import { ReadSkillRegistry } from "./readSkill.macro";

export { searchSkills, SearchSkillsRegistry } from "./searchSkills.macro";
export { readSkill, ReadSkillRegistry } from "./readSkill.macro";

const SkillsMacros = [SearchSkillsRegistry, ReadSkillRegistry];

export default SkillsMacros;
