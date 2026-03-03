interface ChatTypingIndicatorProps {
  typingUsers: { userId: string; userName: string; text: string }[];
}

export function ChatTypingIndicator({
  typingUsers,
}: ChatTypingIndicatorProps) {
  if (typingUsers.length === 0) return null;

  const names = typingUsers.map((u) => u.userName);
  const label =
    names.length === 1
      ? `${names[0]} is typing...`
      : `${names.join(", ")} are typing...`;

  return (
    <div className="px-3 py-1.5 text-xs text-muted-foreground animate-pulse">
      {label}
    </div>
  );
}
