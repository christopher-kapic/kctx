import { defineCommand } from "citty";
import { settingsGetCommand } from "./get.js";
import { settingsSetCommand } from "./set.js";

export const settingsCommand = defineCommand({
  meta: { name: "settings", description: "Manage site settings (admin only)" },
  subCommands: {
    get: settingsGetCommand,
    set: settingsSetCommand,
  },
});
