#!/usr/bin/env node
'use strict';

/**
 * Run a server module's Jest suites from an AI worktree - the ONE supported verification recipe.
 *
 *   node scripts/ai/run-worktree-tests.js <test path or pattern> [...more] [jest options]
 *   node <server>/src/modules/reactory-reactor/scripts/ai/run-worktree-tests.js \
 *        --module-root <worktree> <test path or pattern>     # a repo without its own copy
 *
 * Examples (paths are relative to the module/worktree root):
 *
 *   node scripts/ai/run-worktree-tests.js services/reactor/__tests__/ReactorConversationService.contextLength.test.ts
 *   node scripts/ai/run-worktree-tests.js services/reactor/__tests__ ai/macro/chats
 *   node scripts/ai/run-worktree-tests.js --listTests services/reactor/__tests__
 *
 * EXIT-CODE CONTRACT (see docs/ai-worktree-testing.md)
 * ---------------------------------------------------
 *   0      every collected suite loaded and every test passed
 *   1      at least one suite failed to load, or at least one test failed
 *   1      the wrapper itself could not run Jest (misconfiguration, missing install)
 *
 * That is Jest's own code, with ONE deliberate adjustment: when the inherited server config sets
 * `detectOpenHandles: true`, `--forceExit` is added by default. This repository has known async
 * work that survives teardown (Mongoose query middleware in models/ReactorChatState.ts calls
 * `require()` from its pre-hooks after the environment is torn down), which makes Jest exit 1 on a
 * green run - the PRIMARY checkout does the same with plain `npx jest`. Reporting that as a test
 * failure is a false red, so the wrapper exits 0 when the tests actually passed. The forced exit is
 * announced on stdout and can be disabled with `--no-forceExit` (or
 * REACTORY_WORKTREE_FORCE_EXIT=0), and it can never turn a failing suite green: Jest still reports
 * (and exits 1 for) load failures and failed assertions.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  findServerRoot,
  resolveModuleLayout,
} = require('./worktree-module-resolution');

const CONFIG_PATH = path.join(__dirname, 'jest-worktree.config.js');

const USAGE = `
Run a server module's Jest suites from an AI worktree (the supported verification recipe).

Usage:
  node scripts/ai/run-worktree-tests.js [test paths or patterns] [jest options]

  Test paths are relative to the module root and are resolved to absolute paths when they
  exist, so Jest matches them exactly.

Options handled by this wrapper:
  --module-root <path>   Module/worktree root to test (default: REACTORY_MODULE_ROOT, else
                         the closest enclosing module above this script). Needed only when the
                         harness is invoked from a different repository's checkout.
  --no-forceExit         Do not add --forceExit even when the inherited config enables
                         detectOpenHandles (you inherit the repository's post-teardown noise).
  --help, -h             This text. Everything else is passed to Jest.

Examples:
  node scripts/ai/run-worktree-tests.js services/reactor/__tests__/ReactorConversationService.contextLength.test.ts
  node scripts/ai/run-worktree-tests.js services/reactor/__tests__ ai/macro/chats
  node scripts/ai/run-worktree-tests.js --listTests services/reactor/__tests__

Exit codes: 0 = every collected test passed; 1 = a suite failed to load, a test failed, or
the wrapper could not run Jest. Adding --forceExit never changes 1 to 0 for a real failure.
`;

function fail(message) {
  process.stderr.write(`\n[run-worktree-tests] ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

// ── module root ───────────────────────────────────────────────────────────────
const takeModuleRootFlag = (args) => {
  const out = [];
  let value = '';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--module-root') {
      value = args[index + 1] && !args[index + 1].startsWith('-') ? args[index + 1] : '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--module-root=')) {
      value = arg.slice('--module-root='.length);
      continue;
    }
    out.push(arg);
  }

  return { args: out, value };
};

const moduleRootFlag = takeModuleRootFlag(argv);
const remainingArgs = moduleRootFlag.args;

const resolveModuleRoot = () => {
  const candidates = [];

  if (moduleRootFlag.value) candidates.push(path.resolve(moduleRootFlag.value));
  if (process.env.REACTORY_MODULE_ROOT && process.env.REACTORY_MODULE_ROOT.trim()) {
    candidates.push(path.resolve(process.env.REACTORY_MODULE_ROOT.trim()));
  }
  // Running the harness through a copy that lives elsewhere (e.g. a sibling module's checkout):
  // the caller's cwd is the worktree being tested.
  candidates.push(path.resolve(process.cwd()));
  candidates.push(path.resolve(__dirname, '..', '..'));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    } catch (error) {
      /* keep looking */
    }
  }

  return null;
};

const MODULE_ROOT = resolveModuleRoot();

if (!MODULE_ROOT) {
  fail(
    'could not resolve the module root to test.\n' +
      'Run this from the worktree, pass --module-root <worktree>, or set REACTORY_MODULE_ROOT.',
  );
}

const envServerRoot = process.env.REACTORY_SERVER_ROOT;
const serverRoot = envServerRoot && envServerRoot.trim()
  ? path.resolve(envServerRoot.trim())
  : findServerRoot(MODULE_ROOT);

if (!serverRoot) {
  fail(
    `could not find the host server checkout for ${MODULE_ROOT}.\n` +
      'Expected an ancestor directory whose package.json is named "@reactory/server-core".\n' +
      'Set REACTORY_SERVER_ROOT to the reactory-express-server checkout if it lives elsewhere.',
  );
}

const jestBin = path.join(serverRoot, 'node_modules', 'jest', 'bin', 'jest.js');
if (!fs.existsSync(jestBin)) {
  fail(`no Jest installation at ${jestBin}. Run the package install for ${serverRoot} first.`);
}

const layout = resolveModuleLayout(MODULE_ROOT, { serverRoot });

// ── argument splitting ────────────────────────────────────────────────────────
const separatorIndex = remainingArgs.indexOf('--');
const head = separatorIndex === -1 ? remainingArgs : remainingArgs.slice(0, separatorIndex);
const tail = separatorIndex === -1 ? [] : remainingArgs.slice(separatorIndex);

const JEST_FLAGS_WITH_VALUE = new Set([
  '-t',
  '--testNamePattern',
  '--testPathPattern',
  '--testPathIgnorePatterns',
  '--maxWorkers',
  '-w',
  '--coverageDirectory',
  '--reporters',
  '--outputFile',
  '--selectProjects',
]);

const flags = [];
const patterns = [];

for (let index = 0; index < head.length; index += 1) {
  const arg = head[index];
  if (arg.startsWith('-')) {
    flags.push(arg);
    if (JEST_FLAGS_WITH_VALUE.has(arg) && index + 1 < head.length) {
      index += 1;
      flags.push(head[index]);
    }
  } else {
    patterns.push(arg);
  }
}

const resolvedPatterns = patterns.map((pattern) => {
  const candidate = path.resolve(MODULE_ROOT, pattern);
  return fs.existsSync(candidate) ? candidate : pattern;
});

// ── run-mode + exit-code handling ─────────────────────────────────────────────
const hasRunMode = flags.some((flag) => /^(--runInBand|--maxWorkers|-w|--detectOpenHandles)$/.test(flag));

const forceExitOptOut = flags.includes('--no-forceExit')
  || String(process.env.REACTORY_WORKTREE_FORCE_EXIT || '').trim() === '0';
const callerForcedExit = flags.includes('--forceExit');
const passthroughFlags = flags.filter((flag) => flag !== '--no-forceExit');

/**
 * The inherited server config enables `detectOpenHandles`, and this repository has async work that
 * survives teardown, which makes Jest exit 1 after a fully green run. Read that flag from the same
 * config the run will use and compensate (see the exit-code contract at the top of this file).
 */
const readInheritedConfig = async () => {
  try {
    // The same loader the worktree config uses, so the decision is made from the exact config
    // Jest is about to run with.
    // eslint-disable-next-line global-require
    const { loadServerJestConfig } = require('./load-server-jest-config');
    const config = await loadServerJestConfig(serverRoot);
    return { detectOpenHandles: config.detectOpenHandles === true };
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) };
  }
};

const describeTarget = resolvedPatterns.length
  ? resolvedPatterns.map((pattern) => path.relative(MODULE_ROOT, pattern) || pattern).join(' ')
  : '(all suites in the worktree)';

const offsetNote = layout.offset > 0
  ? `relocated worktree: offset +${layout.offset} level(s) vs the natural mount - the resolver re-anchors relative imports`
  : 'natural mount: offset 0 - the resolver is a no-op';

const header = [
  '',
  '[run-worktree-tests] module      ' + path.relative(serverRoot, MODULE_ROOT),
  '[run-worktree-tests] server      ' + serverRoot,
  '[run-worktree-tests] layout      ' + offsetNote,
  '[run-worktree-tests] config      ' + CONFIG_PATH,
  '[run-worktree-tests] target      ' + describeTarget,
  '',
];

process.stdout.write(header.join('\n'));

(async () => {
  let forceExit = callerForcedExit;

  if (!forceExit && !forceExitOptOut) {
    const inherited = await readInheritedConfig();
    if (inherited.detectOpenHandles) {
      forceExit = true;
      process.stdout.write(
        '[run-worktree-tests] forceExit   on (the inherited server config sets detectOpenHandles and this ' +
          'repository has work that survives teardown;\n' +
          '[run-worktree-tests]              without it Jest exits 1 on an all-green run - see ' +
          'docs/ai-worktree-testing.md)\n\n',
      );
    } else if (inherited.error) {
      process.stdout.write(
        '[run-worktree-tests] forceExit   not applied (could not read the inherited config: ' +
          inherited.error.split('\n')[0] + ')\n\n',
      );
    }
  } else if (forceExitOptOut && !callerForcedExit) {
    process.stdout.write(
      '[run-worktree-tests] forceExit   disabled by --no-forceExit / REACTORY_WORKTREE_FORCE_EXIT=0; ' +
        'a post-teardown error will surface as exit 1\n\n',
    );
  }

  const jestArgs = [
    '--config',
    CONFIG_PATH,
    ...passthroughFlags,
    ...(hasRunMode ? [] : ['--runInBand']),
    ...(forceExit && !callerForcedExit ? ['--forceExit'] : []),
    ...resolvedPatterns,
    ...tail,
  ];

  const command = `node ${jestBin} ${jestArgs.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`;
  process.stdout.write(`[run-worktree-tests] command     ${command}\n\n`);

  const result = spawnSync(process.execPath, [jestBin, ...jestArgs], {
    cwd: serverRoot,
    env: {
      ...process.env,
      REACTORY_SERVER_ROOT: serverRoot,
      REACTORY_MODULE_ROOT: MODULE_ROOT,
      REACTORY_WORKTREE_ROOT: MODULE_ROOT,
    },
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`failed to start Jest: ${result.error.message}`);
  }

  const exitCode = typeof result.status === 'number' ? result.status : 1;

  process.stdout.write(
    `\n[run-worktree-tests] exit code ${exitCode}` +
      (exitCode === 0
        ? ' (every collected test passed)\n'
        : ' (a suite failed to load, a test failed, or the wrapper could not run Jest)\n'),
  );

  process.exit(exitCode);
})();
