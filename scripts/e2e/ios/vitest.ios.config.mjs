import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const launcherDir = join(repoRoot, "web/packages/launcher");
const require = createRequire(join(launcherDir, "package.json"));

const { svelte } = await import(pathToFileURL(require.resolve("@sveltejs/vite-plugin-svelte")).href);
const { defineConfig } = await import(pathToFileURL(require.resolve("vitest/config")).href);
const svelteClient = join(dirname(require.resolve("svelte/package.json")), "src/index-client.js");

export default defineConfig({
    root: launcherDir,
    plugins: [svelte()],
    resolve: {
        alias: {
            "@chan/web-shared/command-deck": join(repoRoot, "web/packages/web-shared/src/command-deck/model.ts"),
            "@chan/web-shared/CommandDeck.svelte": join(
                repoRoot,
                "web/packages/web-shared/src/components/CommandDeck.svelte",
            ),
        },
    },
    test: {
        environment: "jsdom",
        alias: [
            { find: /^svelte$/, replacement: svelteClient },
            {
                find: /^vitest$/,
                replacement: join(dirname(require.resolve("vitest/package.json")), "dist/index.js"),
            },
        ],
        setupFiles: [join(launcherDir, "vitest.setup.ts")],
        include: [join(here, "launcher-ios-e2e.test.ts")],
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
