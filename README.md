# env

Configuration State and Package-to-Materialization MVPs for AppPort.

This repository demonstrates configuration as explicit, typed, deterministic, durable application state built on the actual npm packages:

- `appport@1.0.2`
- `@feltdb/core@0.8.3`

The MVP extends the existing AppPort configuration/application surface instead of introducing a parallel SDK. `defineConfig()` can declare configuration schema/defaults and supported materialization targets, `loadConfig()` remains the underlying AppPort loader, and the local `appport` wrapper forwards existing commands while adding `appport config ...`.

## Example declaration

```js
// appport.config.mjs
import { defineConfig } from 'appport';

export default defineConfig({
  entry: './appport/server.ts',
  materialization: {
    targets: ['browser', 'local']
  },
  config: {
    schema: {
      database: { url: 'string' },
      features: { search: 'boolean' },
      service: { timeoutMs: 'number' }
    },
    defaults: {
      features: { search: false },
      service: { timeoutMs: 1000 }
    }
  }
});
```

The package is the application artifact. AppPort resolves a compatible materialization target outside application source, then passes the same package plus resolved configuration to a target-specific materializer:

```js
import {
  AppPortConfigurationState,
  materializeApplicationPackage
} from 'appport-config-state-mvp';

const configurationState = new AppPortConfigurationState();
const materialized = await materializeApplicationPackage({
  applicationPackage: 'demo-application@1.0.0',
  application: {
    materialization: { targets: ['browser', 'local'] },
    config: { schema: { database: { url: 'string' } } }
  },
  configurationState,
  capability: 'barcode.generate',
  target: 'browser'
});

console.log(materialized.runtime); // wasm
console.log(materialized.configRevision);
console.log(materialized.configHash);
```

## CLI

```sh
npm install
npm test
npx appport config init
npx appport config import .env
npx appport config set database.url postgres://localhost/app
npx appport config get database.url
npx appport config history
npx appport config show 1
npx appport config diff 1 2
npx appport config export-env
```

Non-`config` commands are delegated to the existing `appport@1.0.2` CLI.
