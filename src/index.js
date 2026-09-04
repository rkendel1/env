import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CONFIG,
  defineConfig,
  loadApplication,
  loadConfig,
  runCli,
} from 'appport';
import { createFeltDB } from '@feltdb/core';

export { DEFAULT_CONFIG, defineConfig, loadApplication, loadConfig, runCli };

export const CONFIG_LAYERS = ['defaults', 'environment', 'local', 'override'];
export const CONFIG_SCOPES = ['application', 'environment', 'execution'];
const CONFIG_COLLECTION = 'appport_configuration_revisions';

export function canonicalize(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Configuration numbers must be finite');
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(`Unsupported configuration value type: ${typeof value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function hashConfiguration(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function parsePrimitive(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) return Number(text);
  try {
    const parsed = JSON.parse(text);
    if (isConfigurationValue(parsed)) return parsed;
  } catch {}
  return text;
}

export function parseEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    setPath(values, envNameToConfigPath(match[1]), parsePrimitive(value));
  }
  return values;
}

export function exportEnv(values) {
  return flatten(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${configPathToEnvName(key)}=${formatEnvValue(value)}`)
    .join('\n');
}

export function projectConfigToEnvironment(resolvedConfig, options = {}) {
  const baseEnv = options.baseEnv ?? {};
  const projection = Object.fromEntries(
    flatten(resolvedConfig.values ?? resolvedConfig)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [configPathToEnvName(key), String(value ?? '')]),
  );
  return { ...baseEnv, ...projection };
}

export async function loadAppPortConfig(cwd = process.cwd(), explicit) {
  const loaded = await loadConfig(cwd, explicit);
  const userConfig = loaded.path ? await importUserConfig(loaded.path) : {};
  return {
    ...loaded,
    config: {
      ...loaded.config,
      config: normalizeDeclaration(userConfig.config),
    },
    userConfig,
  };
}

export function createConfigDatabase(options = {}) {
  if (options.db) return options.db;
  if (options.memory) return createFeltDB({ namespace: options.namespace ?? `appport-config-${cryptoRandom()}`, memory: true });
  return createFeltDB({ namespace: options.namespace ?? 'appport-config', path: options.path ?? resolve(options.root ?? process.cwd(), '.appport', 'config-state') });
}

export class AppPortConfigurationState {
  constructor(options = {}) {
    this.db = createConfigDatabase(options);
    this.ownsDb = !options.db;
    this.collection = this.db.collection(CONFIG_COLLECTION);
  }

  async close() {
    if (this.ownsDb && this.db.close) await this.db.close();
  }

  async init(declaration = {}) {
    const latest = await this.latest();
    if (latest) return latest;
    return this.commit({
      schema: normalizeDeclaration(declaration).schema,
      layers: { defaults: normalizeDeclaration(declaration).defaults, environment: {}, local: {}, override: {} },
      scope: { level: 'application' },
      provenance: [{ source: 'appport.config', action: 'init' }],
    });
  }

  async latest() {
    const revisions = await this.history({ ascending: true });
    return revisions.at(-1) ?? null;
  }

  async history(options = {}) {
    const rows = (await this.collection.all()).map(cleanRecord).sort((a, b) => Number(a.revision) - Number(b.revision));
    return options.ascending ? rows : rows.reverse();
  }

  async show(revision) {
    const record = await this.collection.get(String(revision));
    if (!record) throw new Error(`Unknown configuration revision: ${revision}`);
    return cleanRecord(record);
  }

  async commit(nextState, provenance = {}) {
    assertState(nextState);
    const parent = await this.latest();
    const revision = String(parent ? Number(parent.revision) + 1 : 1);
    const state = normalizeState(nextState);
    const record = {
      revision,
      parentRevision: parent?.revision,
      hash: hashConfiguration({ layers: state.layers, schema: state.schema, scope: state.scope }),
      createdAt: new Date().toISOString(),
      state,
      provenance: [...(state.provenance ?? []), normalizeProvenance(provenance)],
      scope: state.scope,
    };
    await this.collection.insert(record, revision);
    return cleanRecord(record);
  }

  async updateLayer(layer, values, provenance = {}) {
    if (!CONFIG_LAYERS.includes(layer)) throw new Error(`Unknown configuration layer: ${layer}`);
    const latest = (await this.latest()) ?? (await this.init());
    const state = normalizeState(latest.state);
    state.layers[layer] = deepMerge(state.layers[layer], values);
    return this.commit(state, { action: `update:${layer}`, ...provenance });
  }

  async set(configPath, value, options = {}) {
    const layer = options.layer ?? 'local';
    const values = {};
    setPath(values, configPath, value);
    return this.updateLayer(layer, values, { source: options.source ?? 'cli', path: configPath });
  }

  async importEnv(file, options = {}) {
    return this.updateLayer(options.layer ?? 'local', parseEnv(await readFile(file, 'utf8')), {
      source: '.env',
      file,
      action: 'import',
    });
  }

  async resolve(options = {}) {
    const latest = (await this.latest()) ?? (await this.init(options.declaration));
    const state = normalizeState(latest.state);
    const override = options.override ? { override: options.override } : {};
    const layers = { ...state.layers, ...override };
    const merged = deepMerge(layers.defaults, layers.environment, layers.local, layers.override);
    validateAgainstSchema(merged, options.schema ?? state.schema);
    const authorizedPaths = options.authorizedPaths ?? leafSchemaPaths(options.schema ?? state.schema);
    const values = authorizedPaths.length > 0 ? projectPaths(merged, authorizedPaths) : merged;
    const scope = normalizeScope(options.scope ?? state.scope ?? { level: 'execution' });
    return {
      values,
      scope,
      configRevision: latest.revision,
      configHash: hashConfiguration(values),
      stateHash: latest.hash,
      provenance: latest.provenance,
    };
  }

  async get(configPath, options = {}) {
    return getPath((await this.resolve(options)).values, configPath);
  }

  async diff(a, b) {
    return diffValues((await this.show(a)).state.layers, (await this.show(b)).state.layers);
  }
}

export function createExecutionEvidence(input) {
  return {
    capability: input.capability,
    configRevision: input.resolvedConfig.configRevision,
    configHash: input.resolvedConfig.configHash,
    configScope: input.resolvedConfig.scope,
    runtime: input.runtime ?? 'local',
    result: input.result ?? 'success',
  };
}

function normalizeDeclaration(declaration = {}) {
  return { schema: declaration.schema ?? {}, defaults: declaration.defaults ?? {}, authorizedPaths: declaration.authorizedPaths ?? [] };
}

function normalizeState(state = {}) {
  return {
    schema: state.schema ?? {},
    layers: {
      defaults: state.layers?.defaults ?? {},
      environment: state.layers?.environment ?? {},
      local: state.layers?.local ?? {},
      override: state.layers?.override ?? {},
    },
    scope: normalizeScope(state.scope ?? { level: 'application' }),
    provenance: state.provenance ?? [],
  };
}

function normalizeScope(scope) {
  const level = scope?.level ?? 'application';
  if (!CONFIG_SCOPES.includes(level)) throw new Error(`Unknown configuration scope: ${level}`);
  return { ...scope, level };
}

function normalizeProvenance(provenance) {
  return { at: new Date().toISOString(), source: 'appport', action: 'commit', ...provenance };
}

function assertState(state) {
  assertConfigurationValue(normalizeState(state).layers);
  assertConfigurationValue(normalizeState(state).schema);
}

function assertConfigurationValue(value, seen = new Set()) {
  if (!isConfigurationValue(value, seen)) throw new TypeError('Configuration state must contain only JSON-compatible values');
}

function isConfigurationValue(value, seen = new Set()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isConfigurationValue(item, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return false;
    seen.add(value);
    const ok = Object.values(value).every((item) => isConfigurationValue(item, seen));
    seen.delete(value);
    return ok;
  }
  return false;
}

function cleanRecord(record) {
  const { id, __version, ...clean } = record;
  return clean;
}

async function importUserConfig(file) {
  if (file.endsWith('.json')) return JSON.parse(await readFile(file, 'utf8'));
  return (await import(`${pathToFileURL(file).href}?appportConfigState=${Date.now()}`)).default ?? {};
}

function splitPath(configPath) {
  if (!configPath || typeof configPath !== 'string') throw new TypeError('Configuration path must be a non-empty string');
  const parts = configPath.split('.').filter(Boolean);
  for (const part of parts) {
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') throw new TypeError(`Unsafe configuration path segment: ${part}`);
  }
  return parts;
}

function getPath(object, configPath) {
  return splitPath(configPath).reduce((current, key) => (current == null ? undefined : current[key]), object);
}

function setPath(object, configPath, value) {
  const keys = splitPath(configPath);
  let current = object;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(current, key) || !current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) {
      Object.defineProperty(current, key, { value: {}, enumerable: true, configurable: true, writable: true });
    }
    current = current[key];
  }
  Object.defineProperty(current, keys.at(-1), { value, enumerable: true, configurable: true, writable: true });
}

function hasPath(object, configPath) {
  return getPath(object, configPath) !== undefined;
}

function projectPaths(source, paths) {
  const projection = {};
  for (const configPath of [...new Set(paths)].sort()) {
    if (hasPath(source, configPath)) setPath(projection, configPath, getPath(source, configPath));
  }
  return projection;
}

function deepMerge(...objects) {
  const result = {};
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) && value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = structuredClone(value);
      }
    }
  }
  return result;
}

function schemaType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateAgainstSchema(values, schema, prefix = '') {
  for (const [key, rule] of Object.entries(schema ?? {})) {
    const configPath = prefix ? `${prefix}.${key}` : key;
    if (typeof rule === 'string') {
      const value = getPath(values, configPath);
      if (value !== undefined && schemaType(value) !== rule) throw new Error(`${configPath} must be ${rule}`);
    } else if (rule && typeof rule === 'object') {
      validateAgainstSchema(values, rule, configPath);
    }
  }
}

function leafSchemaPaths(schema, prefix = '') {
  return Object.entries(schema ?? {}).flatMap(([key, rule]) => {
    const configPath = prefix ? `${prefix}.${key}` : key;
    return typeof rule === 'string' ? [configPath] : leafSchemaPaths(rule, configPath);
  });
}

function flatten(object, prefix = '') {
  if (object && typeof object === 'object' && !Array.isArray(object)) {
    return Object.entries(object).flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, object]];
}

function formatEnvValue(value) {
  const text = value === null ? 'null' : String(value);
  return /^[A-Za-z0-9_./:-]*$/.test(text) ? text : JSON.stringify(text);
}

function envNameToConfigPath(name) {
  return name.toLowerCase().split('_').join('.');
}

function configPathToEnvName(configPath) {
  return configPath.replace(/\./g, '_').toUpperCase();
}

function cryptoRandom() {
  return createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
}

function diffValues(before, after, prefix = '') {
  const beforeObject = before && typeof before === 'object' && !Array.isArray(before);
  const afterObject = after && typeof after === 'object' && !Array.isArray(after);
  if (beforeObject || afterObject) {
    return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
      .sort()
      .flatMap((key) => diffValues(before?.[key], after?.[key], prefix ? `${prefix}.${key}` : key));
  }
  return canonicalize(before) === canonicalize(after) ? [] : [{ path: prefix, before, after }];
}
