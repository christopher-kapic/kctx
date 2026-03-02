import dotenv from "dotenv";
import path from "node:path";
import { defineConfig } from "prisma/config";

dotenv.config({
  path: "../../apps/server/.env",
});

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    // Use process.env — NOT env("DATABASE_URL") from prisma/config
    // env() throws PrismaConfigEnvError when the variable is missing,
    // even during `prisma generate` where no database connection is needed.
    url: process.env.DATABASE_URL,
  },
});
