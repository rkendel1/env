#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  AppPortConfigurationState,
  exportEnv,
  loadAppPortConfig,
  parsePrimitive,
  projectConfigToEnvironment,
  runCli,
} from '../src/index.js';

function help() {
  return `appport config <command>

Commands
  init
  import <file>
  get <path>
  set <path> <value> [--layer defaults|environment|local|override]
  history
  show <revision>
  diff <a> <b>
  export-env`;
}

function flag(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function runConfig(argv, cwd) {
  const [command, ...args] = argv;
  const loaded = await loadAppPortConfig(cwd, flag(args, '--config'));
  const state = new AppPortConfigurationState({ root: cwd });
  try {
    if (command === 'init') {
      const revision = await state.init(loaded.config.config);
      console.log(`Initialized configuration revision ${revision.revision} ${revision.hash.slice(0, 12)}`);
      return 0;
    }
    if (command === 'import') {
      const file = args[0];
      if (!file) throw new Error(help());
      await state.init(loaded.config.config);
      const revision = await state.importEnv(resolve(cwd, file));
      console.log(`Imported ${file} as revision ${revision.revision} ${revision.hash.slice(0, 12)}`);
      return 0;
    }
    if (command === 'get') {
      await state.init(loaded.config.config);
      console.log(JSON.stringify(await state.get(args[0]), null, 2));
      return 0;
    }
    if (command === 'set') {
      const [path, rawValue] = args;
      if (!path || rawValue === undefined) throw new Error(help());
      await state.init(loaded.config.config);
      const revision = await state.set(path, parsePrimitive(rawValue), { layer: flag(args, '--layer', 'local') });
      console.log(`Committed revision ${revision.revision} ${revision.hash.slice(0, 12)}`);
      return 0;
    }
    if (command === 'history') {
      console.log('REVISION\tHASH\tCREATED\tPARENT');
      for (const revision of await state.history()) console.log(`${revision.revision}\t${revision.hash.slice(0, 12)}\t${revision.createdAt}\t${revision.parentRevision ?? ''}`);
      return 0;
    }
    if (command === 'show') {
      console.log(JSON.stringify(await state.show(args[0]), null, 2));
      return 0;
    }
    if (command === 'diff') {
      for (const change of await state.diff(args[0], args[1])) {
        console.log(change.path);
        console.log(`-${JSON.stringify(change.before)}`);
        console.log(`+${JSON.stringify(change.after)}`);
      }
      return 0;
    }
    if (command === 'export-env') {
      await state.init(loaded.config.config);
      console.log(exportEnv((await state.resolve({ schema: loaded.config.config.schema })).values));
      return 0;
    }
    if (command === 'project-env') {
      await state.init(loaded.config.config);
      console.log(JSON.stringify(projectConfigToEnvironment(await state.resolve({ schema: loaded.config.config.schema })), null, 2));
      return 0;
    }
    throw new Error(help());
  } finally {
    await state.close();
  }
}

const argv = process.argv.slice(2);
const exitCode = argv[0] === 'config' ? await runConfig(argv.slice(1), process.cwd()) : await runCli(argv, process.cwd());
process.exitCode = exitCode;
