const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function assertJsonValue(value, seen = new Set()) {
  if (value === null) return;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    if (valueType === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Configuration numbers must be finite');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
    return;
  }
  if (valueType === 'object') {
    if (seen.has(value)) throw new TypeError('Configuration state cannot contain cycles');
    seen.add(value);
    for (const item of Object.values(value)) assertJsonValue(item, seen);
    seen.delete(value);
    return;
  }
  throw new TypeError(`Unsupported configuration value type: ${valueType}`);
}

function canonicalize(value) {
  assertJsonValue(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${entries.join(',')}}`;
}

function cloneJson(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function hashState(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function isSecretBox(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.secret === true &&
      Object.prototype.hasOwnProperty.call(value, 'value')
  );
}

function redactSecrets(value) {
  if (isSecretBox(value)) return '[secret]';
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]));
  }
  return value;
}

function unwrapSecrets(value) {
  if (isSecretBox(value)) return unwrapSecrets(value.value);
  if (Array.isArray(value)) return value.map(unwrapSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapSecrets(item)]));
  }
  return value;
}

function compareValues(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return canonicalize(a) === canonicalize(b);
}

function joinPath(prefix, key) {
  return prefix ? `${prefix}.${key}` : String(key);
}

function semanticDiff(before, after, prefix = '') {
  if (isSecretBox(before) || isSecretBox(after)) {
    if (isSecretBox(before) && isSecretBox(after) && compareValues(before, after)) return [];
    return [{
      path: prefix,
      before: isSecretBox(before) ? '[secret]' : redactSecrets(before),
      after: isSecretBox(after) ? '[secret]' : redactSecrets(after),
    }];
  }
  const beforeObject = before && typeof before === 'object' && !Array.isArray(before);
  const afterObject = after && typeof after === 'object' && !Array.isArray(after);
  if (beforeObject || afterObject) {
    const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).sort();
    return keys.flatMap((key) => semanticDiff(before && before[key], after && after[key], joinPath(prefix, key)));
  }
  if (compareValues(before, after)) return [];
  return [{ path: prefix, before: redactSecrets(before), after: redactSecrets(after) }];
}

class FeltDBStore {
  constructor(options = {}) {
    this.revisions = options.revisions ? cloneJson(options.revisions) : [];
    this.now = options.now || (() => new Date().toISOString());
    if (options.initial !== undefined && this.revisions.length === 0) this.commit(options.initial);
  }

  get current() {
    return this.revisions[this.revisions.length - 1];
  }

  commit(values) {
    const cleanValues = cloneJson(values);
    const previous = this.current;
    const revision = {
      id: String(this.revisions.length + 1),
      hash: hashState(cleanValues),
      parent: previous && previous.id,
      createdAt: this.now(),
      values: cleanValues,
    };
    if (!revision.parent) delete revision.parent;
    this.revisions.push(revision);
    this.persist();
    return cloneJson(revision);
  }

  history() {
    return cloneJson([...this.revisions].reverse());
  }

  show(id) {
    const revision = this.revisions.find((item) => item.id === String(id));
    if (!revision) throw new Error(`Unknown revision: ${id}`);
    return cloneJson(revision);
  }

  diff(a, b) {
    const before = this.show(a).values;
    const after = this.show(b).values;
    return semanticDiff(before, after);
  }

  persist() {}
}

class FileStateStore extends FeltDBStore {
  constructor(filePath, options = {}) {
    const revisions = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')).revisions : undefined;
    super({ ...options, revisions });
    this.filePath = filePath;
    if (revisions === undefined && options.initial !== undefined) this.persist();
  }

  persist() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({ revisions: this.revisions }, null, 2)}\n`);
  }
}

module.exports = {
  FeltDBStore,
  FileStateStore,
  canonicalize,
  cloneJson,
  hashState,
  isSecretBox,
  redactSecrets,
  semanticDiff,
  unwrapSecrets,
};
