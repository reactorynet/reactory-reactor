import { VariableMacroRegistry, SliceVariableMacroRegistry } from './variableMacro.macro';
import { ModuleMacroRegistry } from './moduleMacro.macro';
import { EnvironmentMacroRegistry } from './environmentMacro.macro';
import { StateMacroRegistry } from './stateMacro.macro';
import { AddMacroRegistry } from './addMacro.macro';
import { DateTimeMacroRegistry } from './datetimeMacro.macro';
import { TodoMacroRegistry } from './todoMacro.macro';
import { AddToolsToSessionMacroRegistry, RemoveToolsFromSessionMacroRegistry } from './sessionTools.macro';

export default [
  VariableMacroRegistry,
  SliceVariableMacroRegistry,
  ModuleMacroRegistry,
  EnvironmentMacroRegistry,
  StateMacroRegistry,
  AddMacroRegistry,
  DateTimeMacroRegistry,
  TodoMacroRegistry,
  AddToolsToSessionMacroRegistry,
  RemoveToolsFromSessionMacroRegistry
];