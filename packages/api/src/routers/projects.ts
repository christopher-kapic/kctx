import prisma, { type Prisma } from "@starter/db";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { findOwnedOrThrow } from "../lib/ownership";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { entityId } from "../lib/schemas";

/**
 * Projects — the golden-path example: one private, owner-scoped CRUD list,
 * built the way every feature on this stack should be. See
 * patterns/golden-path.md, which walks this file in build order and lists what
 * to delete if the app has no use for it.
 *
 * Three things here are the point, and none of them is the feature:
 *
 * 1. **Every row this router touches is scoped in the QUERY**, never checked
 *    after the fact. `list` ANDs the owner clause under `withCursor`; the
 *    single-row paths go through {@link findOwnedOrThrow}, which merges the
 *    clause itself so a caller cannot forget it.
 * 2. **A foreign id is NOT_FOUND, not FORBIDDEN.** A project is private enough
 *    that even its existence must not leak; FORBIDDEN would turn the error code
 *    into an existence oracle.
 * 3. **The projection is a disclosure boundary.** {@link projectSelect} is
 *    `satisfies Prisma.ProjectSelect` and is the only shape that reaches a
 *    client — notably not `ownerId`, which the caller already knows and which
 *    nothing on the wire should carry.
 *
 * No procedure budget: nothing here spends money, sends mail, or queues work,
 * so the generic `/rpc/*` limiter is the whole story. A surface that *did* cost
 * something would need its own bucket — patterns/rate-limiting.md § When the
 * surface is a procedure, not a route.
 */

/**
 * The client-facing shape. `createdAt` is both displayed and the cursor anchor,
 * so it is selected once and serves both; a column added here is a disclosure
 * decision, not a formality.
 */
const projectSelect = {
  id: true,
  name: true,
  notes: true,
  createdAt: true,
} satisfies Prisma.ProjectSelect;

// Bare validators. Messages come from the locale-aware Zod error map
// (apps/web/src/i18n/zod.ts); an inline message would be hardcoded English
// forever — patterns/i18n.md § Zod validation messages.
const projectName = z.string().trim().min(1).max(120);
const projectNotes = z.string().trim().max(10_000);
const projectIdInput = z.object({ id: entityId });

/** Says what was not found, never why. Reused by every single-row path. */
const NOT_FOUND = "Project not found";

/**
 * Resolve a project the caller owns, or raise NOT_FOUND.
 *
 * Returns the id only: the row is re-read by the write that follows, and a
 * wider projection here would be a second, undeclared disclosure surface.
 */
function ownedProject(id: string, ownerId: string) {
  return findOwnedOrThrow({
    find: (args) => prisma.project.findFirst(args),
    args: { where: { id }, select: { id: true } },
    owner: { field: "ownerId", id: ownerId },
    notFound: NOT_FOUND,
  });
}

export const projectsRouter = {
  /**
   * One page of the caller's projects, newest first.
   *
   * Bounded by construction: `cursorPageInput` caps `limit` at 100, `pageTake`
   * fetches one extra row to detect `hasMore`, and `cursorPage` slices the page
   * and mints the next token. There is no unbounded variant to reach for.
   */
  list: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const projects = await prisma.project.findMany({
      // The owner scope stays the first `AND` member; the keyset is ANDed onto
      // it, never a replacement for it.
      where: withCursor({ ownerId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      // A TOTAL order. `createdAt` alone is not unique, and a cursor into a
      // non-total order silently repeats or skips rows across pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
      select: projectSelect,
    });
    return cursorPage(projects, input.limit, "createdAt");
  }),

  create: protectedProcedure
    .input(z.object({ name: projectName, notes: projectNotes.optional() }))
    .handler(async ({ input, context }) => {
      return prisma.project.create({
        data: {
          // From the verified session, never from input. An `ownerId` on the
          // wire would let any caller file a row under anyone's account.
          ownerId: context.session.user.id,
          name: input.name,
          // `||`, not `??`: an omitted note and a submitted empty textarea are
          // the same fact, and NULL is how this column says it. A stored ""
          // would be a second sentinel every reader has to know about.
          notes: input.notes || null,
        },
        select: projectSelect,
      });
    }),

  update: protectedProcedure
    .input(projectIdInput.extend({ name: projectName, notes: projectNotes.optional() }))
    .handler(async ({ input, context }) => {
      const project = await ownedProject(input.id, context.session.user.id);
      return prisma.project.update({
        // `project.id` — the id the ownership lookup returned, not `input.id`.
        // They are equal here, and writing it this way keeps them equal if the
        // lookup ever grows a second way to resolve a project.
        where: { id: project.id },
        // An absent (or emptied) `notes` clears the column: the edit form
        // always submits the whole record, so "omitted" means "emptied", not
        // "leave it alone".
        data: { name: input.name, notes: input.notes || null },
        select: projectSelect,
      });
    }),

  delete: protectedProcedure.input(projectIdInput).handler(async ({ input, context }) => {
    const project = await ownedProject(input.id, context.session.user.id);
    await prisma.project.delete({ where: { id: project.id } });
    return { success: true };
  }),
};
