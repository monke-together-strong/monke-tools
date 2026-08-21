import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

const releaseConfig = tegami({
  npm: {
    client: "bun",
    trustedPublish: {
      provider: "github",
      workflow: "publish-packages.yml"
    },
    updateLockFile: true
  },
  packages: {
    "@monke-together-strong/oxc-config": {}
  },
  plugins: [
    github({
      repo: "monke-together-strong/monke-tools",
      versionPr: {
        base: "main"
      }
    })
  ]
});

await runCli(releaseConfig);
