import { defineCommand } from "citty";
import { apiKeysCreateCommand } from "./create.js";
import { apiKeysListCommand } from "./list.js";
import { apiKeysRevokeCommand } from "./revoke.js";

export const apiKeysCommand = defineCommand({
  meta: { name: "api-keys", description: "Manage API keys" },
  subCommands: {
    create: apiKeysCreateCommand,
    list: apiKeysListCommand,
    revoke: apiKeysRevokeCommand,
  },
});
