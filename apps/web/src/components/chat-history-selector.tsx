import { useQuery, useMutation } from "@tanstack/react-query";
import { orpc, queryClient } from "@/utils/orpc";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { History, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ChatHistorySelectorProps {
  packageIdentifier: string;
  currentConversationId?: string;
  onConversationSelect: (conversationId: string) => void;
}

export function ChatHistorySelector({
  packageIdentifier,
  currentConversationId,
  onConversationSelect,
}: ChatHistorySelectorProps) {
  const conversationsQuery = useQuery(
    orpc.conversation.list.queryOptions({
      input: { packageIdentifier },
    }),
  );

  const deleteMutation = useMutation(
    orpc.conversation.delete.mutationOptions({
      onSuccess: () => {
        toast.success("Chat deleted");
        queryClient.invalidateQueries({
          queryKey: orpc.conversation.list.queryOptions({
            input: { packageIdentifier },
          }).queryKey,
        });
      },
      onError: () => {
        toast.error("Failed to delete chat");
      },
    }),
  );

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm("Delete this conversation?")) {
      deleteMutation.mutate({ id });
    }
  };

  const formatDate = (date: string | Date) => {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  const allConversations = [
    ...(conversationsQuery.data?.owned ?? []).map((c) => ({
      ...c,
      isShared: false,
    })),
    ...(conversationsQuery.data?.shared ?? []).map((c) => ({
      ...c,
      isShared: true,
    })),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="text-xs h-7" />}>
        <History className="size-3 mr-1" />
        History
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Chat History</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {conversationsQuery.isLoading ? (
            <DropdownMenuItem disabled>Loading...</DropdownMenuItem>
          ) : allConversations.length === 0 ? (
            <DropdownMenuItem disabled>No previous chats</DropdownMenuItem>
          ) : (
            allConversations.map((conv) => (
              <DropdownMenuItem
                key={conv.id}
                className="flex items-start justify-between gap-2 py-2"
                onSelect={() => onConversationSelect(conv.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">
                    {conv.title || "New chat"}
                    {conv.isShared && (
                      <span className="ml-1 text-muted-foreground">
                        (shared)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(conv.updatedAt)} &middot; {conv._count.messages}{" "}
                    message{conv._count.messages !== 1 ? "s" : ""}
                  </div>
                </div>
                {conv.id === currentConversationId && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    Current
                  </span>
                )}
                {!conv.isShared && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-50 hover:opacity-100 shrink-0"
                    aria-label="Delete conversation"
                    onClick={(e) => handleDelete(e, conv.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
