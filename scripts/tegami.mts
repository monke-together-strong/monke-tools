import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

const releaseConfig = tegami({
  plugins: [
    github({
      repo: "monke-together-strong/monke-tools",
      versionPr: {
        base: "main",
      },
    }),
  ],
  npm: {
    client: "bun",
    updateLockFile: true,
    trustedPublish: {
      provider: "github",
      workflow: "publish.yml",
    },
  },
  packages: {
    "@monke-together-strong/oxlint-config": {},
  },
});

await runCli(releaseConfig);
