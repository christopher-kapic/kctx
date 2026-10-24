import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@starter/env/shared";

import { PrismaClient } from "../prisma/generated/client";

export type { Prisma } from "../prisma/generated/client";

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
});
const prisma = new PrismaClient({ adapter });

export default prisma;
