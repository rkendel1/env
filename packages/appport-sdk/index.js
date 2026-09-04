const fs = require('node:fs');
const path = require('node:path');
const {
  FeltDBStore,
  FileStateStore,
  cloneJson,
  hashState,
  redactSecrets,
  semanticDiff,
  unwrapSecrets,
} = require('@feltdb/core');

const LAYERS = ['defaults', 'environment', 'local', 'override'];

function emptyConfigState() {
  return {
    layers: {
      defaults: {},
      environment: {},
      local: {},
      override: {},
    },
    authorizations: {},
  };
}

function createMemoryConfigStore(initial = emptyConfigState()) {
  return new FeltDBStore({ initial });
}

function createFileConfigStore(filePath = path.join(process.cwd(), '.appport', 'config-state.json')) {
  return new FileStateStore(filePath, { initial: emptyConfigState() });
}

function splitPath(configPath) {
  if (!configPath || typeof configPath !== 'string') throw new TypeError('Configuration path must be a non-empty string');
  return configPath.split('.').filter(Boolean);
}

function getPath(object, configPath) {
  return splitPath(configPath).reduce((current, key) => (current == null ? undefined : current[key]), object);
}

function setPath(object, configPath, value) {
  const keys = splitPath(configPath);
  let current = object;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

function hasPath(object, configPath) {
  return getPath(object, configPath) !== undefined;
}

function deepMerge(...objects) {
  const result = {};
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      const existing = result[key];
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.secret !== true
      ) {
        result[key] = deepMerge(existing, value);
      } else {
        result[key] = cloneJson(value);
      }
    }
  }
  return result;
}

function normalizeState(rawState) {
  const state = cloneJson(rawState || emptyConfigState());
  state.layers ||= {};
  for (const layer of LAYERS) state.layers[layer] ||= {};
  state.authorizations ||= {};
  return state;
}

function resolveLayers(rawState) {
  const state = normalizeState(rawState);
  return deepMerge(...LAYERS.map((layer) => state.layers[layer]));
}

function projectPaths(source, paths) {
  const projection = {};
  for (const configPath of [...new Set(paths)].sort()) {
    if (hasPath(source, configPath)) setPath(projection, configPath, getPath(source, configPath));
  }
  return projection;
}

function schemaType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateSchema(value, schema, location = 'config') {
  if (!schema) return;
  if (typeof schema === 'string') {
    if (schemaType(value) !== schema) throw new Error(`${location} must be ${schema}`);
    return;
  }
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(schemaType(value))) throw new Error(`${location} must be ${allowed.join(' or ')}`);
  }
  if (schema.required && value && typeof value === 'object') {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${location}.${key} is required`);
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateSchema(value[key], childSchema, `${location}.${key}`);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`));
  }
}

function parsePrimitive(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function parseEnv(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    setPath(result, envNameToPath(match[1]), parsePrimitive(value));
  }
  return result;
}

function envNameToPath(name) {
  return name
    .toLowerCase()
    .split('_')
    .map((part) => (part === 'url' ? 'url' : part))
    .join('.');
}

function pathToEnvName(configPath) {
  return configPath.replace(/\./g, '_').toUpperCase();
}

function flattenConfig(object, prefix = '') {
  if (object && typeof object === 'object' && !Array.isArray(object)) {
    return Object.entries(object).flatMap(([key, value]) => flattenConfig(value, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, object]];
}

function formatEnvValue(value) {
  const text = value === null ? 'null' : String(value);
  return /^[A-Za-z0-9_./:-]*$/.test(text) ? text : JSON.stringify(text);
}

function exportEnv(config) {
  return flattenConfig(unwrapSecrets(config))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${pathToEnvName(key)}=${formatEnvValue(value)}`)
    .join('\n');
}

class AppPort {
  constructor(options = {}) {
    this.configStore = options.configStore || createMemoryConfigStore();
    this.declarations = new Map();
    this.authorizations = options.authorizations || {};
    this.executions = [];
  }

  declareConfig(declaration) {
    if (!declaration || !declaration.capability) throw new TypeError('Config declaration requires a capability');
    this.declarations.set(declaration.capability, cloneJson(declaration));
    return declaration;
  }

  grantConfig(capability, paths) {
    this.authorizations[capability] = [...new Set(paths)].sort();
  }

  config(request) {
    const capability = request && request.capability;
    if (!capability) return Promise.reject(new TypeError('Config request requires a capability'));
    const declaration = this.declarations.get(capability) || {};
    const state = normalizeState(this.configStore.current ? this.configStore.current.values : emptyConfigState());
    const resolved = resolveLayers(state);
    const requirements = request.requires || declaration.requires;
    const authorized = this.authorizations[capability] || state.authorizations[capability] || requirements || [];
    const requestedPaths = requirements ? requirements.filter((item) => authorized.includes(item)) : authorized;
    const projection = unwrapSecrets(projectPaths(resolved, requestedPaths));
    validateSchema(projection, request.schema || declaration.schema);
    return Promise.resolve(projection);
  }

  setConfig(pathToSet, value, layer = 'local') {
    if (!LAYERS.includes(layer)) throw new Error(`Unknown configuration layer: ${layer}`);
    const state = normalizeState(this.configStore.current ? this.configStore.current.values : emptyConfigState());
    setPath(state.layers[layer], pathToSet, value);
    return this.configStore.commit(state);
  }

  getConfig(pathToGet) {
    return unwrapSecrets(getPath(resolveLayers(this.configStore.current.values), pathToGet));
  }

  importEnvFile(filePath, layer = 'local') {
    const imported = parseEnv(fs.readFileSync(filePath, 'utf8'));
    const state = normalizeState(this.configStore.current ? this.configStore.current.values : emptyConfigState());
    state.layers[layer] = deepMerge(state.layers[layer], imported);
    return this.configStore.commit(state);
  }

  exportEnv() {
    return exportEnv(resolveLayers(this.configStore.current.values));
  }

  history() {
    return this.configStore.history().map((revision) => ({
      ...revision,
      values: redactSecrets(revision.values),
    }));
  }

  show(revision) {
    const item = this.configStore.show(revision);
    return { ...item, values: redactSecrets(resolveLayers(item.values)) };
  }

  diff(a, b) {
    return semanticDiff(resolveLayers(this.configStore.show(a).values), resolveLayers(this.configStore.show(b).values));
  }

  recordExecution(evidence) {
    const current = this.configStore.current;
    const record = {
      capability: evidence.capability,
      configRevision: current && current.id,
      configHash: current && current.hash,
      runtime: evidence.runtime || 'local',
      result: evidence.result || 'success',
    };
    this.executions.push(record);
    return record;
  }

  async execute(capability, handler, request = { capability }) {
    const config = await this.config({ ...request, capability });
    try {
      const result = await handler(config);
      this.recordExecution({ capability, result: 'success' });
      return result;
    } catch (error) {
      this.recordExecution({ capability, result: 'failure' });
      throw error;
    }
  }
}

module.exports = {
  AppPort,
  LAYERS,
  createFileConfigStore,
  createMemoryConfigStore,
  emptyConfigState,
  exportEnv,
  hashState,
  parseEnv,
  parsePrimitive,
  resolveLayers,
  validateSchema,
};
