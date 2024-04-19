import { KnownReactorProjectTypes } from "@reactory/server-modules/reactor/types/service.types";
import fs from 'fs';

export type FileSVG = string
export type FileSVGMap = { [key: KnownReactorProjectTypes]: FileSVG } 

export default {
  "java": fs.readFileSync(require.resolve('./java.svg')).toString(),
  "tsql": fs.readFileSync(require.resolve('./tsql.svg')).toString(),
  "python": fs.readFileSync(require.resolve('./python.svg')).toString(),
  "javascript": fs.readFileSync(require.resolve('./javascript.svg')).toString(),
  "typescript": fs.readFileSync(require.resolve('./typescript.svg')).toString(),
  "react-native": fs.readFileSync(require.resolve('./react-native.svg')).toString(),
  "react-web": fs.readFileSync(require.resolve('./react-web.svg')).toString(),
  "csharp": fs.readFileSync(require.resolve('./csharp.svg')).toString(),
  "nodejs": fs.readFileSync(require.resolve('./nodejs.svg')).toString(),
  "table": fs.readFileSync(require.resolve('./table.svg')).toString(),
  "view": fs.readFileSync(require.resolve('./view.svg')).toString(),
} as FileSVGMap;
