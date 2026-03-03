// All macro/component implementations have been moved to their own files.
// This file now only imports and re-exports them for backward compatibility.
export * from './ReadFile/ReadFile';
export * from './ReadChatFile/ReadChatFile';
export * from './WriteFile/WriteFile';
export * from './ListDirectory/ListDirectory';
export * from './PathInfo/PathInfo';
export * from './ExtractTextFromFile/ExtractTextFromFile';
export * from './InsertSnippet/InsertSnippet';
export * from './MakeDirectory/MakeDirectory';
export * from './DeleteDirectory/DeleteDirectory';
export * from './CreateModuleStructure/CreateModuleStructure';

import { ReadFileComponentRegister } from './ReadFile/ReadFile';
import { ReadChatFileComponentRegister } from './ReadChatFile/ReadChatFile';
import { WriteFileComponentRegister } from './WriteFile/WriteFile';
import { ListDirectoryComponentRegister } from './ListDirectory/ListDirectory';
import { PathInfoComponentRegister } from './PathInfo/PathInfo';
import { ExtractFileComponentRegister } from './ExtractTextFromFile/ExtractTextFromFile';
import { InsertSnippetComponentRegister } from './InsertSnippet/InsertSnippet';
import { MakeDirectoryComponentRegister } from './MakeDirectory/MakeDirectory';
import { DeleteDirectoryComponentRegister } from './DeleteDirectory/DeleteDirectory';
import { CreateModuleStructureComponentRegister } from './CreateModuleStructure/CreateModuleStructure';

export const FileMacros = [
  ReadFileComponentRegister,
  ReadChatFileComponentRegister,
  WriteFileComponentRegister,
  ListDirectoryComponentRegister,
  ExtractFileComponentRegister,
  InsertSnippetComponentRegister,
  PathInfoComponentRegister,
  MakeDirectoryComponentRegister,
  DeleteDirectoryComponentRegister,
  CreateModuleStructureComponentRegister,
];
