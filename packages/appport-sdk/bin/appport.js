#!/usr/bin/env node
const path = require('node:path');
const { AppPort, createFileConfigStore, parsePrimitive } = require('..');

function usage() {
  return `Usage:
  appport config init
  appport config get <path>
  appport config set <path> <value> [--layer defaults|environment|local|override]
  appport config history
  appport config show <revision>
  appport config diff <a> <b>
  appport config import <file>
  appport config export-env`;
}

function formatValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatDiffValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function main(argv) {
  const [group, command, ...args] = argv;
  if (group !== 'config') throw new Error(usage());
  const store = createFileConfigStore(path.join(process.cwd(), '.appport', 'config-state.json'));
  const appport = new AppPort({ configStore: store });

  switch (command) {
    case 'init':
      console.log(`Initialized AppPort config at ${path.relative(process.cwd(), store.filePath)}`);
      return;
    case 'get': {
      const value = appport.getConfig(args[0]);
      console.log(formatValue(value));
      return;
    }
    case 'set': {
      const layerFlag = args.indexOf('--layer');
      const layer = layerFlag >= 0 ? args[layerFlag + 1] : 'local';
      const pathArg = args[0];
      const valueArg = args[1];
      if (!pathArg || valueArg === undefined) throw new Error(usage());
      const revision = appport.setConfig(pathArg, parsePrimitive(valueArg), layer);
      console.log(`Committed revision ${revision.id} ${revision.hash.slice(0, 12)}`);
      return;
    }
    case 'history':
      console.log('REVISION\tHASH\tCREATED');
      for (const revision of appport.history()) {
        console.log(`${revision.id}\t${revision.hash.slice(0, 12)}\t${revision.createdAt}`);
      }
      return;
    case 'show':
      console.log(JSON.stringify(appport.show(args[0]), null, 2));
      return;
    case 'diff':
      for (const change of appport.diff(args[0], args[1])) {
        console.log(change.path);
        console.log(`-${formatDiffValue(change.before)}`);
        console.log(`+${formatDiffValue(change.after)}`);
      }
      return;
    case 'import': {
      const file = args[0];
      if (!file) throw new Error(usage());
      const revision = appport.importEnvFile(path.resolve(file));
      console.log(`Imported ${file} as revision ${revision.id} ${revision.hash.slice(0, 12)}`);
      return;
    }
    case 'export-env':
      console.log(appport.exportEnv());
      return;
    default:
      throw new Error(usage());
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
