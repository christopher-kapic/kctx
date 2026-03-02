import prisma from "@kctx/db";

import { protectedProcedure } from "../index";

export const statsRouter = {
  get: protectedProcedure.handler(async () => {
    const [packages, repositories, users] = await Promise.all([
      prisma.package.count(),
      prisma.repository.count(),
      prisma.user.count(),
    ]);

    return { packages, repositories, users };
  }),
};
