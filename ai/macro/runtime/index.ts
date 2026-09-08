import { VariableMacroRegistry, SliceVariableMacroRegistry } from './variableMacro.macro';
import { ModuleMacroRegistry } from './moduleMacro.macro';
import { EnvironmentMacroRegistry } from './environmentMacro.macro';
import { StateMacroRegistry } from './stateMacro.macro';
import { AddMacroRegistry } from './addMacro.macro';
import { DateTimeMacroRegistry } from './datetimeMacro.macro';
import { TodoMacroRegistry } from './todoMacro.macro';
import { AddToolsToSessionMacroRegistry, RemoveToolsFromSessionMacroRegistry, ToolkitMacroRegistry } from './sessionTools.macro';
import { ReloadPersonasMacroRegistry } from './reloadPersonas.macro';
import ToolResultProcessor from './ToolResultProcessor';

export { ToolResultProcessor, ToolkitMacroRegistry };

export default [
  VariableMacroRegistry,
  SliceVariableMacroRegistry,
  ModuleMacroRegistry,
  EnvironmentMacroRegistry,
  StateMacroRegistry,
  AddMacroRegistry,
  DateTimeMacroRegistry,
  TodoMacroRegistry,
  ToolkitMacroRegistry,
  AddToolsToSessionMacroRegistry,
  RemoveToolsFromSessionMacroRegistry,
  ReloadPersonasMacroRegistry
];