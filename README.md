# Kikorin

Game engine monorepo. The `apps/web` Next.js app is a throwaway testbed. The publishable packages are `@kikorin/netcode` (Hydra) and `@kikorin/util`.

## New machine setup

1. Install **Node 22** — repo has `.nvmrc`, so `nvm use` / `fnm use` / `mise install` picks up the right version automatically
2. Run `corepack enable` — activates pnpm at the pinned version
3. Clone the repo
4. Run `pnpm install`

## Daily dev

```sh
pnpm dev        # run the web app
pnpm test       # run all tests
pnpm build      # build all packages
pnpm typecheck  # check types
```

## Publish a release

```sh
pnpm ship
```

Walks through an interactive prompt (which packages changed, patch / minor / major, one-line summary), then bumps versions, builds, and publishes to npm automatically. Requires a logged-in npm session — run `npm login` once if you get a 401.

## Vercel deployment

**One-time setup in the Vercel dashboard:** set the project's **Root Directory** to `apps/web`. After that, every push to `main` deploys automatically. `apps/web/vercel.json` handles the build and install commands.

## Publishing a new package

1. Add `tsup` to the package's `devDependencies` and `"build": "tsup"` to its scripts — copy `tsup.config.ts` from `packages/netcode/`
2. Add `"files": ["dist"]` and a `publishConfig` block pointing exports to `dist/` — copy the pattern from `packages/netcode/package.json`
3. Remove `"private": true` from the package's `package.json`
4. Add `--filter=@kikorin/<pkg-name>` to the `ship` and `release` scripts in the root `package.json`
