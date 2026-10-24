import type {
  ChatMessageRow,
  ChatSessionRow,
  serializeChatMessage,
  serializeChatSession,
} from "./chat";

type IsExact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2
    ? (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual ? 1 : 2
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

export type ChatSessionContract = Assert<
  IsExact<ReturnType<typeof serializeChatSession>, { id: string; title: string; status: string }>
>;
export type ChatSessionRowKeysContract = Assert<
  IsExact<keyof ChatSessionRow, "id" | "title" | "status">
>;
export type ChatMessageContract = Assert<
  IsExact<
    ReturnType<typeof serializeChatMessage>,
    { id: string; seq: number; role: string; state: string; parts: ChatMessageRow["parts"] }
  >
>;
export type ChatMessageRowKeysContract = Assert<
  IsExact<keyof ChatMessageRow, "id" | "seq" | "role" | "state" | "parts">
>;
