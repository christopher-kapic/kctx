import { defineCommand } from "citty";
import { reposListCommand } from "./list.js";
import { reposUpdateCommand } from "./update.js";

export const reposCommand = defineCommand({
  meta: { name: "repos", description: "Manage repositories" },
  subCommands: {
    list: reposListCommand,
    update: reposUpdateCommand,
  },
});
