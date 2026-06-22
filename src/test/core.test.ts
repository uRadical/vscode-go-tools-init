import * as assert from 'assert';
import {
  parseToolDirectives,
  defaultArgs,
  detectLintTool,
  uniqueBinaries,
  shimTarget,
  taskLabel,
  isExcludedModPath,
  moduleRelPath,
  computeAlternateTools,
  computeTasks,
  stripJsonc,
  isGeneratedShimValue,
  isShimContents,
  isGeneratedTask,
  ModuleSpec,
  VscodeTask,
} from '../core';

const GOLANGCI_V2 = 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint';
const GOLANGCI_V1 = 'github.com/golangci/golangci-lint/cmd/golangci-lint';
const GOIMPORTS = 'golang.org/x/tools/cmd/goimports';

function mod(relPath: string, ...imports: string[]): ModuleSpec {
  return {
    relPath,
    tools: imports.map((importPath) => ({
      importPath,
      binary: importPath.split('/').filter(Boolean).pop()!,
    })),
  };
}

suite('parseToolDirectives', () => {
  test('single-line form', () => {
    const tools = parseToolDirectives(`module x\n\ngo 1.24\n\ntool ${GOIMPORTS}\n`);
    assert.deepStrictEqual(tools, [{ importPath: GOIMPORTS, binary: 'goimports' }]);
  });

  test('block form', () => {
    const tools = parseToolDirectives(`tool (\n\t${GOLANGCI_V2}\n\t${GOIMPORTS}\n)\n`);
    assert.deepStrictEqual(tools.map((t) => t.binary), ['golangci-lint', 'goimports']);
  });

  test('strips line comments and ignores other directives', () => {
    const goMod = [
      'module x',
      'go 1.24',
      'require golang.org/x/tools v0.1.0 // indirect',
      `tool ${GOIMPORTS} // keep imports tidy`,
    ].join('\n');
    const tools = parseToolDirectives(goMod);
    assert.deepStrictEqual(tools, [{ importPath: GOIMPORTS, binary: 'goimports' }]);
  });

  test('de-duplicates repeated import paths', () => {
    const tools = parseToolDirectives(`tool (\n\t${GOIMPORTS}\n\t${GOIMPORTS}\n)`);
    assert.strictEqual(tools.length, 1);
  });

  test('no directives → empty', () => {
    assert.deepStrictEqual(parseToolDirectives('module x\n\ngo 1.24\n'), []);
  });
});

suite('defaultArgs', () => {
  test('known tools', () => {
    assert.deepStrictEqual(defaultArgs('golangci-lint'), ['run', './...']);
    assert.deepStrictEqual(defaultArgs('goimports'), ['-l', '.']);
  });
  test('unknown tool → none', () => {
    assert.deepStrictEqual(defaultArgs('mockgen'), []);
  });
});

suite('detectLintTool', () => {
  test('every module has golangci-lint (v2)', () => {
    const modules = [mod('a', GOLANGCI_V2, GOIMPORTS), mod('b', GOLANGCI_V2)];
    assert.strictEqual(detectLintTool(modules), 'golangci-lint-v2');
  });

  test('v1 import path → golangci-lint', () => {
    assert.strictEqual(detectLintTool([mod('', GOLANGCI_V1)]), 'golangci-lint');
  });

  test('mixed: one module lacks it → undefined (no global linter imposed)', () => {
    const modules = [mod('auth', GOLANGCI_V2), mod('api', GOIMPORTS)];
    assert.strictEqual(detectLintTool(modules), undefined);
  });

  test('no module declares it → undefined', () => {
    assert.strictEqual(detectLintTool([mod('a', GOIMPORTS)]), undefined);
  });

  test('empty → undefined', () => {
    assert.strictEqual(detectLintTool([]), undefined);
  });
});

suite('uniqueBinaries', () => {
  test('de-duplicates and sorts across modules', () => {
    const modules = [mod('auth', GOLANGCI_V2, GOIMPORTS), mod('api', GOIMPORTS)];
    assert.deepStrictEqual(uniqueBinaries(modules), ['goimports', 'golangci-lint']);
  });
});

suite('shimTarget / taskLabel', () => {
  test('shimTarget is workspace-root relative', () => {
    assert.strictEqual(shimTarget('goimports'), '${workspaceFolder}/.tools/goimports');
  });

  test('taskLabel prefixes nested modules, plain for root', () => {
    const lint = { importPath: GOLANGCI_V2, binary: 'golangci-lint' };
    assert.strictEqual(taskLabel('services/auth', lint), 'services/auth: golangci-lint run ./...');
    assert.strictEqual(taskLabel('', lint), 'go tool: golangci-lint run ./...');
  });
});

suite('isExcludedModPath / moduleRelPath', () => {
  test('excludes vendor and testdata trees', () => {
    assert.ok(isExcludedModPath('vendor/x/go.mod'));
    assert.ok(isExcludedModPath('services/auth/testdata/fake/go.mod'));
    assert.ok(isExcludedModPath('a/vendor/b/go.mod'));
  });
  test('does not exclude normal modules', () => {
    assert.ok(!isExcludedModPath('go.mod'));
    assert.ok(!isExcludedModPath('services/auth/go.mod'));
    // "vendored" must not trip the vendor/ segment match
    assert.ok(!isExcludedModPath('services/vendored/go.mod'));
  });
  test('moduleRelPath strips go.mod, root → empty', () => {
    assert.strictEqual(moduleRelPath('go.mod'), '');
    assert.strictEqual(moduleRelPath('services/auth/go.mod'), 'services/auth');
    assert.strictEqual(moduleRelPath('services\\auth\\go.mod'), 'services/auth');
  });
});

suite('computeAlternateTools', () => {
  test('maps each binary to its root shim, deduping collisions', () => {
    const modules = [mod('auth', GOLANGCI_V2, GOIMPORTS), mod('api', GOIMPORTS)];
    const { value, changed } = computeAlternateTools({}, modules);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(value, {
      'golangci-lint': '${workspaceFolder}/.tools/golangci-lint',
      goimports: '${workspaceFolder}/.tools/goimports',
    });
  });

  test('never overwrites existing entries', () => {
    const existing = { goimports: '/custom/goimports' };
    const { value } = computeAlternateTools(existing, [mod('a', GOIMPORTS)]);
    assert.strictEqual(value.goimports, '/custom/goimports');
  });

  test('idempotent: re-running over existing entries reports no change', () => {
    const first = computeAlternateTools({}, [mod('a', GOIMPORTS)]);
    const second = computeAlternateTools(first.value, [mod('a', GOIMPORTS)]);
    assert.strictEqual(second.changed, false);
  });
});

suite('computeTasks', () => {
  test('module-prefixed labels with per-module cwd', () => {
    const { value, changed } = computeTasks([], [mod('services/auth', GOLANGCI_V2)]);
    assert.strictEqual(changed, true);
    assert.strictEqual(value.length, 1);
    assert.strictEqual(value[0].label, 'services/auth: golangci-lint run ./...');
    assert.deepStrictEqual(value[0].args, ['tool', 'golangci-lint', 'run', './...']);
    assert.deepStrictEqual(value[0].options, { cwd: '${workspaceFolder}/services/auth' });
  });

  test('root module has no cwd option', () => {
    const { value } = computeTasks([], [mod('', GOIMPORTS)]);
    assert.strictEqual(value[0].options, undefined);
  });

  test('idempotent: existing label is not duplicated', () => {
    const existing: VscodeTask[] = [{ label: 'go tool: goimports -l .' }];
    const { value, changed } = computeTasks(existing, [mod('', GOIMPORTS)]);
    assert.strictEqual(changed, false);
    assert.strictEqual(value.length, 1);
  });
});

suite('clean detection helpers', () => {
  test('isGeneratedShimValue matches our shim paths only', () => {
    assert.ok(isGeneratedShimValue('${workspaceFolder}/.tools/goimports'));
    assert.ok(!isGeneratedShimValue('/usr/local/bin/goimports'));
    assert.ok(!isGeneratedShimValue('${workspaceFolder}/bin/goimports'));
    assert.ok(!isGeneratedShimValue(undefined));
  });

  test('isShimContents recognises a shim we wrote', () => {
    assert.ok(isShimContents('#!/usr/bin/env bash\nexec go tool goimports "$@"\n'));
    assert.ok(isShimContents('#!/usr/bin/env bash\nexec go tool golangci-lint "$@"'));
    assert.ok(!isShimContents('#!/usr/bin/env bash\necho hi\n'));
    assert.ok(!isShimContents('arbitrary user script'));
  });

  test('isGeneratedTask matches go-tool tasks only', () => {
    assert.ok(isGeneratedTask({ command: 'go', args: ['tool', 'goimports', '-l', '.'] }));
    assert.ok(!isGeneratedTask({ command: 'go', args: ['build', './...'] }));
    assert.ok(!isGeneratedTask({ command: 'make', args: ['lint'] }));
    assert.ok(!isGeneratedTask({ label: 'no args' }));
  });
});

suite('stripJsonc', () => {
  test('removes comments and trailing commas', () => {
    const jsonc = `{
      // a line comment
      "a": 1, /* block */
      "b": [1, 2,],
    }`;
    assert.deepStrictEqual(JSON.parse(stripJsonc(jsonc)), { a: 1, b: [1, 2] });
  });

  test('leaves comment-like content inside strings alone', () => {
    const jsonc = '{ "url": "http://example.com" }';
    assert.deepStrictEqual(JSON.parse(stripJsonc(jsonc)), { url: 'http://example.com' });
  });
});
