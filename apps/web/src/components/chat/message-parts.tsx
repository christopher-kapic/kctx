import { Button } from "@starter/ui/components/button";
import { CodeSnippet } from "@starter/ui/components/code-snippet";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";

import type { ChatPart } from "@/hooks/use-chat-stream";

/**
 * Renders the `AgentMessagePart[]` stored on a chat message.
 *
 * Deliberately generic: a text part is markdown, anything else with a tool
 * shape is a collapsible name / arguments / output disclosure, and thinking
 * parts are dropped. Product-specific part renderers (a proposal card, a result
 * table) belong in the consuming app, not here — add a branch above the
 * `ToolPart` fallback.
 */

function ToolPart({ part }: { part: ChatPart }) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(false);
  const name = typeof part.name === "string" ? part.name : t("chat:tools.activity");
  const args = typeof part.arguments === "string" ? part.arguments : "";
  // `output` is the tool-call spelling, `content` the tool-result spelling.
  const output = part.output ?? part.content;

  return (
    <div className="rounded-lg border bg-muted/30">
      <Button
        variant="ghost"
        className="min-h-[44px] w-full justify-between px-3"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate font-mono text-xs">{name}</span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </Button>
      {open ? (
        <div className="space-y-2 border-t p-3 text-xs">
          {args ? (
            <CodeSnippet
              code={args}
              preClassName="max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap border-0 bg-background p-2 pr-12"
            />
          ) : null}
          {output !== undefined ? (
            <CodeSnippet
              code={typeof output === "string" ? output : JSON.stringify(output, null, 2)}
              preClassName="max-h-56 overflow-y-auto overscroll-contain whitespace-pre-wrap border-0 bg-background p-2 pr-12"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MessageParts({ parts }: { parts: ChatPart[] }) {
  return (
    <div className="space-y-2">
      {parts.map((part, partIndex) => {
        // The index disambiguates repeated identical tool calls, which carry no
        // id of their own until the provider assigns one.
        const key = `${partIndex}-${part.type}-${String(part.id ?? part.toolCallId ?? "")}`;
        if (part.type === "text" && typeof part.content === "string") {
          return <ReactMarkdown key={key}>{part.content}</ReactMarkdown>;
        }
        // Chain-of-thought is not shown: it is neither durable nor an answer.
        if (part.type === "thinking") return null;
        return <ToolPart key={key} part={part} />;
      })}
    </div>
  );
}
