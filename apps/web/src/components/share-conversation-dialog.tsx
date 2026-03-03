import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { orpc, queryClient } from "@/utils/orpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Share2, X, UserPlus } from "lucide-react";
import { toast } from "sonner";

interface ShareConversationDialogProps {
  conversationId: string;
  conversationTitle: string;
}

export function ShareConversationDialog({
  conversationId,
  conversationTitle,
}: ShareConversationDialogProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [confirmUser, setConfirmUser] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // Search users
  const searchUsersQuery = useQuery(
    debouncedQuery.length >= 1
      ? orpc.conversation.searchUsers.queryOptions({
          input: { query: debouncedQuery },
        })
      : {
          queryKey: ["skip-user-search"],
          queryFn: () => [] as { id: string; name: string; email: string; image: string | null }[],
          enabled: false,
        },
  );

  // Get shared users
  const sharedWithQuery = useQuery(
    open
      ? orpc.conversation.getSharedWith.queryOptions({
          input: { conversationId },
        })
      : {
          queryKey: ["skip-shared-with"],
          queryFn: () => [] as { id: string; name: string; email: string; image: string | null }[],
          enabled: false,
        },
  );

  const shareMutation = useMutation(
    orpc.conversation.share.mutationOptions({
      onSuccess: () => {
        toast.success(`Shared with ${confirmUser?.name}`);
        setConfirmUser(null);
        setSearchQuery("");
        queryClient.invalidateQueries({
          queryKey: orpc.conversation.getSharedWith.queryOptions({
            input: { conversationId },
          }).queryKey,
        });
      },
      onError: (error) => {
        toast.error(
          error instanceof Error ? error.message : "Failed to share",
        );
      },
    }),
  );

  const unshareMutation = useMutation(
    orpc.conversation.unshare.mutationOptions({
      onSuccess: () => {
        toast.success("Access removed");
        queryClient.invalidateQueries({
          queryKey: orpc.conversation.getSharedWith.queryOptions({
            input: { conversationId },
          }).queryKey,
        });
      },
      onError: () => {
        toast.error("Failed to remove access");
      },
    }),
  );

  const handleShare = () => {
    if (!confirmUser) return;
    shareMutation.mutate({
      conversationId,
      userId: confirmUser.id,
    });
  };

  const handleUnshare = (userId: string) => {
    unshareMutation.mutate({ conversationId, userId });
  };

  const sharedUserIds = new Set(
    (sharedWithQuery.data ?? []).map((u) => u.id),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" className="text-xs h-7" />}>
        <Share2 className="size-3 mr-1" />
        Share
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share Conversation</DialogTitle>
          <DialogDescription>
            Share &ldquo;{conversationTitle}&rdquo; with other users
          </DialogDescription>
        </DialogHeader>

        {confirmUser ? (
          <div className="space-y-4">
            <p className="text-sm">
              Share this conversation with{" "}
              <strong>{confirmUser.name}</strong> ({confirmUser.email})?
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmUser(null)}>
                Cancel
              </Button>
              <Button onClick={handleShare} disabled={shareMutation.isPending}>
                {shareMutation.isPending ? "Sharing..." : "Confirm"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />

            {/* Search results */}
            {debouncedQuery.length >= 1 && (
              <div className="max-h-40 overflow-y-auto border rounded">
                {searchUsersQuery.isLoading ? (
                  <div className="p-2 text-xs text-muted-foreground">
                    Searching...
                  </div>
                ) : (searchUsersQuery.data ?? []).length === 0 ? (
                  <div className="p-2 text-xs text-muted-foreground">
                    No users found
                  </div>
                ) : (
                  (searchUsersQuery.data ?? []).slice(0, 5).map((user) => (
                    <button
                      key={user.id}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center justify-between"
                      onClick={() =>
                        setConfirmUser({
                          id: user.id,
                          name: user.name,
                          email: user.email,
                        })
                      }
                      disabled={sharedUserIds.has(user.id)}
                    >
                      <div>
                        <div className="font-medium">{user.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {user.email}
                        </div>
                      </div>
                      {sharedUserIds.has(user.id) ? (
                        <span className="text-xs text-muted-foreground">
                          Already shared
                        </span>
                      ) : (
                        <UserPlus className="size-4 text-muted-foreground" />
                      )}
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Currently shared with */}
            {(sharedWithQuery.data ?? []).length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">
                  Shared with
                </h4>
                <div className="space-y-1">
                  {(sharedWithQuery.data ?? []).map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between px-3 py-1.5 text-sm border rounded"
                    >
                      <div>
                        <span className="font-medium">{user.name}</span>
                        <span className="text-xs text-muted-foreground ml-2">
                          {user.email}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => handleUnshare(user.id)}
                        disabled={unshareMutation.isPending}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
