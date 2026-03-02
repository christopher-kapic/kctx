import { defineCommand } from "citty";
import { packagesListCommand } from "./list.js";
import { packagesAddCommand } from "./add.js";
import { packagesRemoveCommand } from "./remove.js";
import { packagesUpdateCommand } from "./update.js";

export const packagesCommand = defineCommand({
  meta: { name: "packages", description: "Manage packages" },
  subCommands: {
    list: packagesListCommand,
    add: packagesAddCommand,
    remove: packagesRemoveCommand,
    update: packagesUpdateCommand,
  },
});
