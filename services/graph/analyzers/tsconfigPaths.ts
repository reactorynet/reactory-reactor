import * as ts from "typescript";
import fs from "fs";
import path from "path";

export interface TsconfigInfo {
  configPath: string;
  configDir: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

export const CANDIDATE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const dirToConfigMap = new Map<string, string | null>();
const configToParsedMap = new Map<string, TsconfigInfo | null>();

/** Clear the tsconfig resolution cache (useful for tests). */
export function clearTsconfigCache(): void {
  dirToConfigMap.clear();
  configToParsedMap.clear();
}

/**
 * Check whether a target path resolves to an existing file with candidate extensions
 * or as a directory index file.
 */
export function checkFileExists(targetPath: string): string | null {
  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = targetPath + ext;
    if (fs.existsSync(candidate)) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore stat errors
      }
    }
  }
  if (fs.existsSync(targetPath)) {
    try {
      if (fs.statSync(targetPath).isDirectory()) {
        for (const ext of CANDIDATE_EXTENSIONS) {
          if (ext === "") continue;
          const candidate = path.join(targetPath, `index${ext}`);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        }
      }
    } catch {
      // ignore stat errors
    }
  }
  return null;
}

/**
 * Walk directory ancestry from `fromFile` up to `repoPath` looking for
 * `tsconfig.json` or `tsconfig.build.json`.
 */
export function findTsconfigPath(fromFile: string, repoPath: string): string | null {
  const normRepo = path.resolve(repoPath);
  let currentDir = path.resolve(path.dirname(fromFile));
  const visitedDirs: string[] = [];

  while (true) {
    if (dirToConfigMap.has(currentDir)) {
      const found = dirToConfigMap.get(currentDir)!;
      for (const d of visitedDirs) {
        dirToConfigMap.set(d, found);
      }
      return found;
    }

    visitedDirs.push(currentDir);

    const tsconfigJson = path.join(currentDir, "tsconfig.json");
    if (fs.existsSync(tsconfigJson)) {
      try {
        if (fs.statSync(tsconfigJson).isFile()) {
          for (const d of visitedDirs) {
            dirToConfigMap.set(d, tsconfigJson);
          }
          return tsconfigJson;
        }
      } catch {
        // ignore stat error
      }
    }

    const tsconfigBuildJson = path.join(currentDir, "tsconfig.build.json");
    if (fs.existsSync(tsconfigBuildJson)) {
      try {
        if (fs.statSync(tsconfigBuildJson).isFile()) {
          for (const d of visitedDirs) {
            dirToConfigMap.set(d, tsconfigBuildJson);
          }
          return tsconfigBuildJson;
        }
      } catch {
        // ignore stat error
      }
    }

    if (currentDir === normRepo || currentDir === path.dirname(currentDir)) {
      break;
    }

    const parentDir = path.dirname(currentDir);
    if (!parentDir.startsWith(normRepo) && parentDir !== normRepo) {
      break;
    }
    currentDir = parentDir;
  }

  for (const d of visitedDirs) {
    dirToConfigMap.set(d, null);
  }
  return null;
}

/**
 * Load and parse a tsconfig file, extracting baseUrl and paths.
 */
export function loadTsconfig(configPath: string): TsconfigInfo | null {
  if (configToParsedMap.has(configPath)) {
    return configToParsedMap.get(configPath)!;
  }

  try {
    let rawConfig: any = null;
    if (ts && typeof ts.readConfigFile === "function") {
      const readResult = ts.readConfigFile(
        configPath,
        (p: string) => fs.readFileSync(p, "utf-8")
      );
      if (!readResult.error && readResult.config) {
        rawConfig = readResult.config;
      }
    }

    if (!rawConfig) {
      const content = fs.readFileSync(configPath, "utf-8");
      rawConfig = JSON.parse(content);
    }

    const configDir = path.dirname(configPath);
    let baseUrl: string | undefined;
    let paths: Record<string, string[]> | undefined;

    if (ts && typeof ts.parseJsonConfigFileContent === "function" && ts.sys) {
      const parsed = ts.parseJsonConfigFileContent(rawConfig, ts.sys, configDir);
      if (parsed.options) {
        if (parsed.options.baseUrl) {
          baseUrl = path.resolve(parsed.options.baseUrl);
        }
        if (parsed.options.paths) {
          paths = parsed.options.paths as Record<string, string[]>;
        }
      }
    }

    const compilerOptions = rawConfig?.compilerOptions || {};
    if (!baseUrl && compilerOptions.baseUrl) {
      baseUrl = path.resolve(configDir, compilerOptions.baseUrl);
    }
    if (!paths && compilerOptions.paths) {
      paths = compilerOptions.paths;
    }

    const info: TsconfigInfo = {
      configPath,
      configDir,
      baseUrl,
      paths,
    };
    configToParsedMap.set(configPath, info);
    return info;
  } catch {
    configToParsedMap.set(configPath, null);
    return null;
  }
}

interface MatchedPattern {
  pattern: string;
  prefixLength: number;
  suffixLength: number;
  starValue: string;
}

/**
 * Resolve a non-relative import specifier using tsconfig compilerOptions.paths and baseUrl.
 * Returns the absolute path of the resolved in-repo file, or null if not found.
 */
export function resolveTsconfigImport(
  fromFile: string,
  specifier: string,
  repoPath: string
): string | null {
  if (!specifier || specifier.startsWith(".")) return null;

  const configPath = findTsconfigPath(fromFile, repoPath);
  if (!configPath) return null;

  const info = loadTsconfig(configPath);
  if (!info) return null;

  const baseDir = info.baseUrl || info.configDir;
  const normRepo = path.resolve(repoPath);

  // 1. Try paths patterns
  if (info.paths) {
    const matchedPatterns: MatchedPattern[] = [];

    for (const pattern of Object.keys(info.paths)) {
      if (!pattern.includes("*")) {
        if (pattern === specifier) {
          matchedPatterns.push({
            pattern,
            prefixLength: pattern.length,
            suffixLength: 0,
            starValue: "",
          });
        }
      } else {
        const starIdx = pattern.indexOf("*");
        const prefix = pattern.slice(0, starIdx);
        const suffix = pattern.slice(starIdx + 1);
        if (
          specifier.startsWith(prefix) &&
          specifier.endsWith(suffix) &&
          specifier.length >= prefix.length + suffix.length
        ) {
          const starValue = specifier.slice(
            prefix.length,
            specifier.length - suffix.length
          );
          matchedPatterns.push({
            pattern,
            prefixLength: prefix.length,
            suffixLength: suffix.length,
            starValue,
          });
        }
      }
    }

    // Longest prefix match first, then longest suffix
    matchedPatterns.sort((a, b) => {
      if (b.prefixLength !== a.prefixLength) {
        return b.prefixLength - a.prefixLength;
      }
      return b.suffixLength - a.suffixLength;
    });

    for (const match of matchedPatterns) {
      const targetPatterns = info.paths[match.pattern] || [];
      for (const targetPattern of targetPatterns) {
        let substituted = targetPattern;
        if (targetPattern.includes("*")) {
          substituted = targetPattern.replace(/\*/g, match.starValue);
        }
        const targetAbs = path.resolve(baseDir, substituted);
        const resolved = checkFileExists(targetAbs);
        if (resolved) {
          const normResolved = path.resolve(resolved);
          const rel = path.relative(normRepo, normResolved);
          if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
            return normResolved;
          }
        }
      }
    }
  }

  // 2. Try baseUrl + specifier
  if (info.baseUrl) {
    const targetAbs = path.resolve(info.baseUrl, specifier);
    const resolved = checkFileExists(targetAbs);
    if (resolved) {
      const normResolved = path.resolve(resolved);
      const rel = path.relative(normRepo, normResolved);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return normResolved;
      }
    }
  }

  return null;
}
