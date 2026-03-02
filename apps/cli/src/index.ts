import { defineCommand, runMain } from "citty";
import { loginCommand } from "./commands/login.js";
import { packagesCommand } from "./commands/packages/index.js";
import { reposCommand } from "./commands/repos/index.js";
import { apiKeysCommand } from "./commands/api-keys/index.js";
import { settingsCommand } from "./commands/settings/index.js";

const main = defineCommand({
  meta: {
    name: "kctx",
    description: "Kinetic Context CLI",
  },
  subCommands: {
    login: loginCommand,
    packages: packagesCommand,
    repos: reposCommand,
    "api-keys": apiKeysCommand,
    settings: settingsCommand,
  },
});

runMain(main);
