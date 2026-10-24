import { Button } from "@starter/ui/components/button";
import { Textarea } from "@starter/ui/components/textarea";
import { Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isSendKey } from "@/lib/chat-composer";

/** Mirrors the `chat.send` input ceiling — the server rejects anything longer. */
const MAX_MESSAGE_LENGTH = 8000;

export function ChatComposer({
  disabled,
  sending,
  onSend,
}: {
  disabled: boolean;
  sending: boolean;
  /** Resolves `true` when the message was accepted; only then is the draft cleared. */
  onSend: (text: string) => Promise<boolean>;
}) {
  const { t } = useTranslation(["chat"]);
  const [text, setText] = useState("");

  const submit = async () => {
    const value = text.trim();
    if (!value || value.length > MAX_MESSAGE_LENGTH || disabled || sending) return;
    // The draft survives a failed send — retyping a long question because the
    // network blipped is the fastest way to lose someone's trust.
    if (await onSend(value)) setText("");
  };

  return (
    <div className="border-t bg-background p-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (isSendKey(event)) {
              event.preventDefault();
              void submit();
            }
          }}
          disabled={disabled}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={2}
          inputMode="text"
          autoComplete="off"
          aria-label={t("chat:composer.label")}
          placeholder={t("chat:composer.placeholder")}
          className="min-h-[52px] resize-none text-base"
        />
        <Button
          className="min-h-[44px] min-w-[44px]"
          disabled={disabled || sending || !text.trim()}
          onClick={() => void submit()}
          aria-label={t("chat:composer.send")}
        >
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {disabled ? t("chat:composer.thinking") : t("chat:composer.hint")}
      </p>
    </div>
  );
}
