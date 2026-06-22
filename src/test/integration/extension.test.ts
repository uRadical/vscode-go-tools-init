import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Integration smoke test — runs inside a real VS Code extension host via
 * @vscode/test-cli. Verifies the extension activates and contributes its command.
 * The detailed scaffolding logic is covered host-free in ../core.test.ts.
 */
suite('extension integration', () => {
  test('activates and registers the goToolsInit.init command', async () => {
    const ext = vscode.extensions.getExtension('uradical.vscode-go-tools-init');
    assert.ok(ext, 'extension should be present');

    await ext!.activate();
    assert.ok(ext!.isActive, 'extension should be active');

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('goToolsInit.init'),
      'goToolsInit.init should be registered',
    );
  });
});
