import { env } from "@kctx/env/server";
import { PrismaLibSql } from "@prisma/adapter-libsql";

import { PrismaClient } from "../prisma/generated/client";

const adapter = new PrismaLibSql({
  url: env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

export default prisma;

export { AuthMethod, CloneStatus, EmbeddingStatus } from "../prisma/generated/enums";
export type { AuthMethod as AuthMethodType, CloneStatus as CloneStatusType, EmbeddingStatus as EmbeddingStatusType } from "../prisma/generated/enums";
