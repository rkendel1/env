import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defineConfig } from 'appport';
import {
  AppPortConfigurationState,
  MaterializationError,
  createExecutionEvidence,
  exportEnv,
  hashConfiguration,
  loadAppPortConfig,
  materializeApplicationPackage,
  parseEnv,
  projectConfigToEnvironment,
  resolveMaterializationTarget,
} from '../src/index.js';

test('loads configuration declaration through the appport config surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'appport-config-load-'));
  writeFileSync(join(root, 'appport.config.json'), JSON.stringify({
    entry: './appport/server.ts',
    config: {
      schema: { database: { url: 'string' }, features: { search: 'boolean' } },
      defaults: { features: { search: true } },
    },
  }));

  const loaded = await loadAppPortConfig(root);
  assert.equal(loaded.config.entry, './appport/server.ts');
  assert.deepEqual(loaded.config.config.schema.database, { url: 'string' });
  assert.deepEqual(loaded.config.config.defaults, { features: { search: true } });
});

test('defineConfig from appport remains the authoritative identity helper', () => {
  const config = defineConfig({ entry: './server.js', config: { schema: { service: { timeoutMs: 'number' } } } });
  assert.deepEqual(config.config.schema.service, { timeoutMs: 'number' });
});

test('FeltDB-backed configuration revisions are durable and deterministic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'appport-config-state-'));
  const first = new AppPortConfigurationState({ root });
  await first.init({ schema: { database: { port: 'number' } }, defaults: { database: { port: 5432 } } });
  const revision2 = await first.set('database.port', 5433, { layer: 'local' });
  await first.close();

  const second = new AppPortConfigurationState({ root });
  assert.equal((await second.get('database.port')), 5433);
  assert.equal((await second.latest()).revision, revision2.revision);
  assert.deepEqual(await second.diff('1', '2'), [{ path: 'local.database.port', before: undefined, after: 5433 }]);
  await second.close();

  assert.equal(hashConfiguration({ b: 2, a: 1 }), hashConfiguration({ a: 1, b: 2 }));
});

test('resolution applies layers, schema validation, authorization, scope, and execution evidence', async () => {
  const state = new AppPortConfigurationState({ memory: true });
  await state.init({
    schema: {
      database: { url: 'string', poolSize: 'number' },
      features: { search: 'boolean' },
      payments: { secret: 'string' },
    },
    defaults: { database: { poolSize: 5 }, features: { search: false }, payments: { secret: 'hidden' } },
  });
  await state.updateLayer('environment', { database: { url: 'postgres://env' } }, { source: 'environment configuration' });
  await state.updateLayer('local', { database: { poolSize: 10 } }, { source: 'project configuration' });

  const resolved = await state.resolve({
    authorizedPaths: ['database.url', 'database.poolSize', 'features.search'],
    override: { features: { search: true } },
    scope: { level: 'execution', id: 'exec-1' },
  });

  assert.deepEqual(resolved.values, {
    database: { url: 'postgres://env', poolSize: 10 },
    features: { search: true },
  });
  assert.equal(resolved.values.payments, undefined);
  assert.equal(resolved.scope.level, 'execution');
  assert.equal(resolved.configRevision, '3');
  assert.equal(resolved.configHash, hashConfiguration(resolved.values));
  assert.deepEqual(createExecutionEvidence({ capability: 'billing.process', resolvedConfig: resolved }), {
    capability: 'billing.process',
    configRevision: resolved.configRevision,
    configHash: resolved.configHash,
    configScope: resolved.scope,
    runtime: 'local',
    result: 'success',
  });
  await state.close();
});

test('.env import preserves primitive values and provenance, export-env preserves legacy compatibility', async () => {
  const state = new AppPortConfigurationState({ memory: true });
  const root = mkdtempSync(join(tmpdir(), 'appport-config-env-'));
  const envFile = join(root, '.env');
  writeFileSync(envFile, 'DATABASE_URL=postgres://db\nPORT=3000\nDEBUG=true\nEMPTY=null\n');

  await state.init({ schema: { database: { url: 'string' }, port: 'number', debug: 'boolean', empty: 'null' } });
  const revision = await state.importEnv(envFile);
  const resolved = await state.resolve();

  assert.deepEqual(parseEnv('DATABASE_URL=postgres://db\nPORT=3000\nDEBUG=true\nEMPTY=null\n'), {
    database: { url: 'postgres://db' },
    port: 3000,
    debug: true,
    empty: null,
  });
  assert.equal(revision.provenance.at(-1).source, '.env');
  assert.equal(exportEnv(resolved.values), 'DATABASE_URL=postgres://db\nDEBUG=true\nEMPTY=null\nPORT=3000');
  assert.deepEqual(projectConfigToEnvironment(resolved, { baseEnv: { APPPORT_EXECUTION_ID: '123' } }), {
    APPPORT_EXECUTION_ID: '123',
    DATABASE_URL: 'postgres://db',
    DEBUG: 'true',
    EMPTY: '',
    PORT: '3000',
  });
  await state.close();
});

test('CLI adds config namespace while preserving appport v1.0.2 commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'appport-config-cli-'));
  const cli = join(process.cwd(), 'bin', 'appport.js');
  writeFileSync(join(root, 'appport.config.json'), JSON.stringify({ config: { schema: { database: { port: 'number' } } } }));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' }).trim();

  assert.equal(run('--version'), '1.0.2');
  assert.match(run('config', 'init'), /Initialized configuration revision 1/);
  assert.match(run('config', 'set', 'database.port', '5432'), /Committed revision 2/);
  assert.equal(run('config', 'get', 'database.port'), '5432');
  assert.match(run('config', 'history'), /REVISION\tHASH\tCREATED\tPARENT/);
});

test('materialization declaration loads through AppPort config and resolves requested targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'appport-materialization-load-'));
  writeFileSync(join(root, 'appport.config.json'), JSON.stringify({
    entry: './appport/server.ts',
    materialization: { targets: ['browser', 'local'] },
    config: { schema: { service: { timeoutMs: 'number' } }, defaults: { service: { timeoutMs: 1000 } } },
  }));

  const loaded = await loadAppPortConfig(root);
  assert.deepEqual(loaded.config.materialization, { targets: ['browser', 'local'] });
  assert.equal(resolveMaterializationTarget(loaded.config.materialization, { target: 'browser' }), 'browser');
  assert.throws(
    () => resolveMaterializationTarget(loaded.config.materialization, { target: 'remote' }),
    (error) => error instanceof MaterializationError && error.code === 'NO_COMPATIBLE_MATERIALIZATION',
  );
});

test('browser/WASM and local/Node materializers use the same package and resolved configuration', async () => {
  const state = new AppPortConfigurationState({ memory: true });
  await state.init({
    schema: { database: { url: 'string' }, private: { token: 'string' } },
    defaults: { database: { url: 'postgres://local' }, private: { token: 'hidden' } },
    authorizedPaths: ['database.url'],
  });

  const application = {
    entry: './appport/server.ts',
    manifestPath: './appport/manifest.json',
    config: { schema: { database: { url: 'string' }, private: { token: 'string' } }, authorizedPaths: ['database.url'] },
    materialization: { targets: ['browser', 'local'] },
  };
  const common = {
    applicationPackage: 'demo-application@1.0.0',
    application,
    configurationState: state,
    capability: 'barcode.generate',
  };

  const browser = await materializeApplicationPackage({ ...common, target: 'browser' });
  const local = await materializeApplicationPackage({ ...common, target: 'local' });

  assert.equal(browser.applicationPackage, common.applicationPackage);
  assert.equal(local.applicationPackage, common.applicationPackage);
  assert.equal(browser.runtime, 'wasm');
  assert.equal(local.runtime, 'node');
  assert.equal(browser.environment.DATABASE_URL, 'postgres://local');
  assert.equal(local.environment.DATABASE_URL, 'postgres://local');
  assert.equal(browser.environment.PRIVATE_TOKEN, undefined);
  assert.equal(browser.configRevision, local.configRevision);
  assert.equal(browser.configHash, local.configHash);
  assert.deepEqual(browser.execution, {
    capability: 'barcode.generate',
    configRevision: browser.configRevision,
    configHash: browser.configHash,
    configScope: { level: 'execution', target: 'browser' },
    runtime: 'wasm',
    result: 'materialized',
  });
  await state.close();
});

test('package-manager installation consumes the application artifact without target-specific source', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'appport-package-consumer-'));
  execFileSync('npm', ['install', '--ignore-scripts', process.cwd()], { cwd: consumer, stdio: 'ignore' });
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { resolveMaterializationTarget, hashConfiguration } from 'appport-config-state-mvp';
    console.log(resolveMaterializationTarget({ targets: ['browser', 'local'] }, { target: 'local' }));
    console.log(hashConfiguration({ b: 2, a: 1 }) === hashConfiguration({ a: 1, b: 2 }));
  `], { cwd: consumer, encoding: 'utf8' }).trim().split(/\r?\n/);

  assert.deepEqual(output, ['local', 'true']);
});
