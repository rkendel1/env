# env

AppPort Config MVP: typed, scoped, versioned application configuration without ambient `process.env` state.

This repository contains two workspace packages:

- `@feltdb/core`: canonical JSON state hashing, immutable configuration revisions, history, semantic diff, and secret redaction helpers.
- `@appport/sdk`: AppPort configuration capability resolution, declaration/schema validation, projection by capability, execution evidence, `.env` import/export, and a small `appport config` CLI.

## Quick start

```sh
npm install
npm test
npx appport config init
npx appport config set database.port 5432
npx appport config get database.port
```

Applications request scoped configuration explicitly:

```js
const { AppPort } = require('@appport/sdk')

const appport = new AppPort()
appport.declareConfig({
  capability: 'demo',
  requires: ['database.port']
})
appport.grantConfig('demo', ['database.port'])

const config = await appport.config({ capability: 'demo' })
console.log(config.database.port)
```

Legacy adapters are available for migration only:

```sh
npx appport config import .env
npx appport config export-env
```
