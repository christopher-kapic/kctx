import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  queueCount?: number;
  onTyping?: (text: string) => void;
}

export function ChatInput({
  onSend,
  disabled,
  placeholder = "Ask a question about this package...",
  queueCount = 0,
  onTyping,
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setMessage("");
      // Clear typing indicator on send
      if (onTyping) onTyping("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessage(value);

    if (onTyping) {
      if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
      typingDebounceRef.current = setTimeout(() => {
        onTyping(value);
      }, 300);
    }
  };

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
    };
  }, []);

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
          onChange={handleChange}
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
