const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { canonicalize, hashState } = require('../packages/feltdb-core');
const { AppPort, createFileConfigStore, createMemoryConfigStore, parseEnv } = require('../packages/appport-sdk');

test('canonical FeltDB hashes are deterministic for equivalent configuration', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
  assert.equal(hashState({ b: 2, a: 1 }), hashState({ a: 1, b: 2 }));
  assert.notEqual(hashState({ a: 1 }), hashState({ a: 2 }));
});

test('AppPort resolves layered scoped typed configuration and records evidence', async () => {
  const appport = new AppPort({ configStore: createMemoryConfigStore() });
  appport.setConfig('database.port', 5432, 'defaults');
  appport.setConfig('database.poolSize', 5, 'environment');
  appport.setConfig('database.poolSize', 10, 'local');
  appport.setConfig('payments.secret', { value: 'do-not-log', secret: true }, 'local');
  appport.grantConfig('demo', ['database.port', 'database.poolSize']);
  appport.declareConfig({
    capability: 'demo',
    requires: ['database.port', 'database.poolSize', 'payments.secret'],
    schema: {
      type: 'object',
      required: ['database'],
      properties: {
        database: {
          type: 'object',
          required: ['port', 'poolSize'],
          properties: {
            port: { type: 'number' },
            poolSize: { type: 'number' },
          },
        },
      },
    },
  });

  const config = await appport.config({ capability: 'demo' });
  assert.deepEqual(config, { database: { port: 5432, poolSize: 10 } });
  assert.equal(config.payments, undefined);

  const result = await appport.execute('demo', (resolved) => resolved.database.port);
  assert.equal(result, 5432);
  assert.deepEqual(Object.keys(appport.executions[0]).sort(), [
    'capability',
    'configHash',
    'configRevision',
    'result',
    'runtime',
  ]);
  assert.equal(appport.executions[0].configRevision, appport.configStore.current.id);
  assert.equal(appport.executions[0].configHash, appport.configStore.current.hash);
});

test('configuration changes create revisions, deterministic diffs, and redacted history output', () => {
  const appport = new AppPort({ configStore: createMemoryConfigStore() });
  appport.setConfig('database.port', 5432);
  const before = appport.configStore.current;
  appport.setConfig('database.port', 5433);
  appport.setConfig('payments.secret', { value: 'shh', secret: true });
  const after = appport.configStore.current;

  assert.notEqual(before.id, after.id);
  assert.notEqual(before.hash, after.hash);
  assert.deepEqual(appport.diff(before.id, after.id), [
    { path: 'database.port', before: 5432, after: 5433 },
    { path: 'payments.secret', before: undefined, after: '[secret]' },
  ]);
  assert.equal(JSON.stringify(appport.show(after.id)).includes('shh'), false);
  assert.equal(JSON.stringify(appport.history()).includes('shh'), false);
});

test('dotenv compatibility imports structured primitive values and exports legacy env', () => {
  const imported = parseEnv('DATABASE_URL=postgres://db\nPORT=3000\nDEBUG=true\nEMPTY=null\n');
  assert.deepEqual(imported, {
    database: { url: 'postgres://db' },
    port: 3000,
    debug: true,
    empty: null,
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appport-config-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'DATABASE_URL=postgres://db\nPORT=3000\nDEBUG=true\n');
  const store = createFileConfigStore(path.join(dir, '.appport', 'config-state.json'));
  const appport = new AppPort({ configStore: store });
  appport.importEnvFile(envFile);

  assert.equal(appport.getConfig('database.url'), 'postgres://db');
  assert.equal(appport.getConfig('port'), 3000);
  assert.equal(appport.exportEnv(), 'DATABASE_URL=postgres://db\nDEBUG=true\nPORT=3000');
});

test('CLI supports init, set, get, history, diff, import, and export-env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appport-cli-'));
  const cli = path.join(__dirname, '..', 'packages', 'appport-sdk', 'bin', 'appport.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' }).trim();

  assert.match(run('config', 'init'), /Initialized AppPort config/);
  assert.match(run('config', 'set', 'database.port', '5432'), /Committed revision 2/);
  assert.equal(run('config', 'get', 'database.port'), '5432');
  assert.match(run('config', 'history'), /REVISION\tHASH\tCREATED/);
  assert.match(run('config', 'set', 'database.port', '5433'), /Committed revision 3/);
  assert.match(run('config', 'diff', '2', '3'), /database\.port\n-5432\n\+5433/);

  fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://db\nDEBUG=false\n');
  assert.match(run('config', 'import', '.env'), /Imported \.env as revision 4/);
  assert.equal(run('config', 'export-env'), 'DATABASE_PORT=5433\nDATABASE_URL=postgres://db\nDEBUG=false');
});
