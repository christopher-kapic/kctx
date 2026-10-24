import type { RouterClient } from "@orpc/server";

import type { ChatMessageRow } from "../lib/chat";
import type { chatRouter } from "./chat";
import type { projectsRouter } from "./projects";

type IsExact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2
    ? (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual ? 1 : 2
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

type ChatClient = RouterClient<typeof chatRouter>;
type ChatSession = Awaited<ReturnType<ChatClient["getSession"]>>;
type ChatMessage = Awaited<ReturnType<ChatClient["listMessages"]>>["items"][number];
export type ChatRouterSessionContract = Assert<
  IsExact<ChatSession, { id: string; title: string; status: string }>
>;
export type ChatRouterMessageContract = Assert<
  IsExact<
    ChatMessage,
    { id: string; seq: number; role: string; state: string; parts: ChatMessageRow["parts"] }
  >
>;

type ProjectsClient = RouterClient<typeof projectsRouter>;
type Project = Awaited<ReturnType<ProjectsClient["list"]>>["items"][number];
/**
 * The golden-path projection, pinned at the client boundary. `ownerId` is the
 * field this assertion exists to keep out: adding it to `projectSelect` would
 * put it on the wire for every row, and only a compile-time exact-type check
 * notices a projection that grew.
 */
export type ProjectsRouterListContract = Assert<
  IsExact<Project, { id: string; name: string; notes: string | null; createdAt: Date }>
>;
export type ProjectsRouterCreateContract = Assert<
  IsExact<Awaited<ReturnType<ProjectsClient["create"]>>, Project>
>;
