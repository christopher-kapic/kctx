import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  queueCount?: number;
}

export function ChatInput({
  onSend,
  disabled,
  placeholder = "Ask a question about this package...",
  queueCount = 0,
}: ChatInputProps) {
  const [message, setMessage] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setMessage("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="space-y-2">
      {queueCount > 0 && (
        <div className="text-xs text-muted-foreground px-1">
          {queueCount} {queueCount === 1 ? "message" : "messages"} queued
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="min-h-[60px] resize-none"
          rows={2}
        />
        <Button
          type="submit"
          disabled={disabled || !message.trim()}
          size="icon"
          className="self-end"
        >
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}
