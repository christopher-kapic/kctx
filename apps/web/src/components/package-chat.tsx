import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { orpc, queryClient } from "@/utils/orpc";
import { ChatMessage } from "@/components/chat-message";
import { ChatInput } from "@/components/chat-input";
import { ChatHistorySelector } from "@/components/chat-history-selector";
import { ShareConversationDialog } from "@/components/share-conversation-dialog";
import { ChatTypingIndicator } from "@/components/chat-typing-indicator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  id: string;
  thinking?: string;
}

interface PackageChatProps {
  packageIdentifier: string;
  initialConversationId?: string;
}

export function PackageChat({
  packageIdentifier,
  initialConversationId,
}: PackageChatProps) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const [conversationId, setConversationId] = useState<string | undefined>(
    initialConversationId,
  );
  const [currentStreamingText, setCurrentStreamingText] = useState("");
  const [currentStreamingThinking, setCurrentStreamingThinking] = useState<
    string | undefined
  >();
  const [isStreaming, setIsStreaming] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastProcessedIndexRef = useRef(-1);
  const hasAddedFinalMessageRef = useRef(false);
  const hasLoadedHistoryRef = useRef(false);
  const savedMessageIdsRef = useRef<Set<string>>(new Set());

  const currentStreamingTextRef = useRef("");
  const currentStreamingThinkingRef = useRef<string | undefined>(undefined);
  const [typingUsers, setTypingUsers] = useState<
    Map<string, { userId: string; userName: string; text: string }>
  >(new Map());
  const typingTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // Fetch available models
  const modelsQuery = useQuery(
    orpc.package.getAvailableModels.queryOptions({}),
  );

  // Fetch agent info
  const agentInfoQuery = useQuery(orpc.package.getAgentInfo.queryOptions({}));

  // Load conversation history when conversationId is set
  const conversationQuery = useQuery(
    conversationId
      ? orpc.conversation.get.queryOptions({
          input: { id: conversationId },
        })
      : { queryKey: ["skip-conversation"], queryFn: () => null, enabled: false },
  );

  // Load history from server when conversation loads
  useEffect(() => {
    if (
      conversationQuery.data &&
      conversationQuery.data.messages &&
      !hasLoadedHistoryRef.current
    ) {
      hasLoadedHistoryRef.current = true;
      const loadedMessages: Message[] = conversationQuery.data.messages.map(
        (m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          id: m.id,
          thinking: m.thinking ?? undefined,
        }),
      );
      setMessages(loadedMessages);
      // Track already-saved message IDs
      for (const m of loadedMessages) {
        savedMessageIdsRef.current.add(m.id);
      }
    }
  }, [conversationQuery.data]);

  // Create conversation mutation
  const createConversationMutation = useMutation(
    orpc.conversation.create.mutationOptions(),
  );

  // Add message mutation
  const addMessageMutation = useMutation(
    orpc.conversation.addMessage.mutationOptions(),
  );

  // Set default model when models load
  useEffect(() => {
    if (modelsQuery.data && !selectedModel) {
      const { models, defaultModel } = modelsQuery.data;
      if (models.length > 0) {
        const modelToUse =
          defaultModel || `${models[0].providerId}/${models[0].modelId}`;
        setSelectedModel(modelToUse);
      }
    }
  }, [modelsQuery.data, selectedModel]);

  // Sync refs with state
  useEffect(() => {
    currentStreamingTextRef.current = currentStreamingText;
    currentStreamingThinkingRef.current = currentStreamingThinking;
  }, [currentStreamingText, currentStreamingThinking]);

  // Scroll to bottom
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({
        behavior: isStreaming ? "auto" : "smooth",
      });
    }
  }, [messages.length, isStreaming]);

  // Sync conversationId to URL
  useEffect(() => {
    if (conversationId) {
      navigate({
        to: "/packages/$identifier/chat",
        params: { identifier: packageIdentifier },
        search: { conversationId },
        replace: true,
      });
    }
  }, [conversationId, packageIdentifier, navigate]);

  // SSE stream for realtime collaboration
  const realtimeQuery = useQuery(
    conversationId
      ? orpc.realtime.stream.experimental_streamedOptions({
          input: { conversationId },
          retry: true,
          queryFnOptions: { refetchMode: "reset" },
        })
      : { queryKey: ["skip-realtime"], queryFn: () => null, enabled: false },
  );

  // Handle realtime events
  useEffect(() => {
    if (!realtimeQuery.data || !Array.isArray(realtimeQuery.data)) return;

    for (const event of realtimeQuery.data) {
      if (event.type === "typing") {
        const key = event.userId;
        if (event.isTyping) {
          setTypingUsers((prev) => {
            const next = new Map(prev);
            next.set(key, {
              userId: event.userId,
              userName: event.userName,
              text: event.text,
            });
            return next;
          });
          // Auto-clear after 3s
          const existing = typingTimeoutRef.current.get(key);
          if (existing) clearTimeout(existing);
          typingTimeoutRef.current.set(
            key,
            setTimeout(() => {
              setTypingUsers((prev) => {
                const next = new Map(prev);
                next.delete(key);
                return next;
              });
            }, 3000),
          );
        } else {
          setTypingUsers((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        }
      } else if (event.type === "message") {
        // Add message from another user
        const msg = event.message;
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [
            ...prev,
            {
              role: msg.role as "user" | "assistant",
              content: msg.content,
              id: msg.id,
            },
          ];
        });
      }
    }
  }, [realtimeQuery.data]);

  // Broadcast typing mutation
  const broadcastTypingMutation = useMutation(
    orpc.realtime.broadcastTyping.mutationOptions(),
  );

  // Save message to server
  const saveMessage = useCallback(
    async (
      convId: string,
      role: "user" | "assistant",
      content: string,
      thinking?: string,
    ) => {
      try {
        const result = await addMessageMutation.mutateAsync({
          conversationId: convId,
          role,
          content,
          thinking,
        });
        savedMessageIdsRef.current.add(result.id);
      } catch (error) {
        console.error("[Chat] Failed to save message:", error);
      }
    },
    [addMessageMutation],
  );

  // Streaming query
  const [streamingQueryKey, setStreamingQueryKey] = useState<{
    identifier: string;
    message: string;
    model: string;
    conversationId?: string;
  } | null>(null);

  const streamingQuery = useQuery(
    streamingQueryKey
      ? orpc.package.chat.experimental_streamedOptions({
          input: {
            identifier: streamingQueryKey.identifier,
            message: streamingQueryKey.message,
            model: streamingQueryKey.model,
            conversationId: streamingQueryKey.conversationId,
          },
          retry: true,
          queryFnOptions: {
            refetchMode: "reset",
          },
        })
      : {
          queryKey: ["skip"],
          queryFn: () => null,
          enabled: false,
        },
  );

  // Handle streaming data
  useEffect(() => {
    if (streamingQuery.data && Array.isArray(streamingQuery.data)) {
      const events = streamingQuery.data;
      const startIndex = lastProcessedIndexRef.current + 1;

      if (startIndex < events.length) {
        const newEvents = events.slice(startIndex);
        let accumulatedText = currentStreamingTextRef.current;
        let latestThinking: string | undefined =
          currentStreamingThinkingRef.current;

        for (const event of newEvents) {
          if (event.text) {
            accumulatedText += event.text;
          }

          if (event.thinking !== undefined) {
            latestThinking = event.thinking;
            setCurrentStreamingThinking(latestThinking);
          }

          if (event.sessionId) {
            const newSessionId = event.sessionId;
            setConversationId((prev) =>
              !prev || prev !== newSessionId ? newSessionId : prev,
            );
          }

          if (event.done) {
            setCurrentStreamingText("");
            setIsStreaming(false);
            setCurrentStreamingThinking(undefined);
            hasAddedFinalMessageRef.current = true;

            if (accumulatedText) {
              const assistantMessage: Message = {
                role: "assistant",
                content: accumulatedText,
                id: `assistant-${Date.now()}-${Math.random()}`,
                thinking: latestThinking,
              };
              setMessages((prev) => [...prev, assistantMessage]);

              // Save assistant message to server
              // Use the conversationId from ref since state may not be updated yet
              const convId = event.sessionId || conversationId;
              if (convId) {
                saveMessage(
                  convId,
                  "assistant",
                  accumulatedText,
                  latestThinking,
                );
              }
            }

            setStreamingQueryKey(null);
            lastProcessedIndexRef.current = -1;
            hasAddedFinalMessageRef.current = false;

            // Invalidate conversation list to update sidebar
            queryClient.invalidateQueries({
              queryKey: orpc.conversation.list.queryOptions({
                input: { packageIdentifier },
              }).queryKey,
            });
            return;
          }
        }

        if (accumulatedText !== currentStreamingTextRef.current) {
          setCurrentStreamingText(accumulatedText);
        }

        lastProcessedIndexRef.current = events.length - 1;
        setIsStreaming(true);
      }
    } else if (streamingQuery.isLoading || streamingQuery.isFetching) {
      setIsStreaming(true);
    }
  }, [
    streamingQuery.data,
    streamingQuery.isLoading,
    streamingQuery.isFetching,
    streamingQuery.error,
    streamingQueryKey,
    conversationId,
    packageIdentifier,
    saveMessage,
  ]);

  // Handle errors
  useEffect(() => {
    if (streamingQuery.error) {
      const error = streamingQuery.error;
      const errorMessage: Message = {
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : "Failed to get response. Please try again."}`,
        id: `error-${Date.now()}`,
      };
      setMessages((prev) => [...prev, errorMessage]);
      setCurrentStreamingText("");
      setCurrentStreamingThinking(undefined);
      setIsStreaming(false);
      setStreamingQueryKey(null);
    }
  }, [streamingQuery.error]);

  const processMessage = useCallback(
    async (trimmedMessage: string) => {
      if (!selectedModel) return;

      let convId = conversationId;

      // Create a server-side conversation if we don't have one
      if (!convId) {
        try {
          const conv = await createConversationMutation.mutateAsync({
            packageIdentifier,
            title: trimmedMessage.substring(0, 100),
          });
          convId = conv.id;
          setConversationId(convId);
        } catch (error) {
          console.error("[Chat] Failed to create conversation:", error);
          // Continue without persistence
        }
      }

      const userMessage: Message = {
        role: "user",
        content: trimmedMessage,
        id: `user-${Date.now()}`,
      };
      setMessages((prev) => [...prev, userMessage]);

      // Save user message to server
      if (convId) {
        saveMessage(convId, "user", trimmedMessage);
      }

      setCurrentStreamingText("");
      setCurrentStreamingThinking(undefined);
      setIsStreaming(true);
      lastProcessedIndexRef.current = -1;
      hasAddedFinalMessageRef.current = false;

      setStreamingQueryKey({
        identifier: packageIdentifier,
        message: trimmedMessage,
        model: selectedModel,
        conversationId: convId,
      });
    },
    [
      selectedModel,
      conversationId,
      packageIdentifier,
      createConversationMutation,
      saveMessage,
    ],
  );

  const handleSendMessage = (message: string) => {
    if (!selectedModel) return;
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    if (isStreaming) {
      setMessageQueue((prev) => [...prev, trimmedMessage]);
      return;
    }

    processMessage(trimmedMessage);
  };

  // Process queue when streaming stops
  useEffect(() => {
    if (!isStreaming && messageQueue.length > 0 && selectedModel) {
      const nextMessage = messageQueue[0];
      setMessageQueue((prev) => prev.slice(1));
      setTimeout(() => {
        processMessage(nextMessage);
      }, 100);
    }
  }, [isStreaming, messageQueue.length, selectedModel, processMessage]);

  const handleNewChat = () => {
    setMessages([]);
    setConversationId(undefined);
    setCurrentStreamingText("");
    setCurrentStreamingThinking(undefined);
    setIsStreaming(false);
    lastProcessedIndexRef.current = -1;
    hasAddedFinalMessageRef.current = false;
    hasLoadedHistoryRef.current = false;
    savedMessageIdsRef.current.clear();
    setStreamingQueryKey(null);

    navigate({
      to: "/packages/$identifier/chat",
      params: { identifier: packageIdentifier },
      search: {},
      replace: true,
    });
  };

  const handleConversationSelect = (id: string) => {
    // Reset state for loading new conversation
    setMessages([]);
    setCurrentStreamingText("");
    setCurrentStreamingThinking(undefined);
    setIsStreaming(false);
    lastProcessedIndexRef.current = -1;
    hasAddedFinalMessageRef.current = false;
    hasLoadedHistoryRef.current = false;
    savedMessageIdsRef.current.clear();
    setStreamingQueryKey(null);
    setConversationId(id);
  };

  if (modelsQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (modelsQuery.error) {
    return (
      <div className="rounded border border-destructive p-4 flex items-center gap-2 text-sm">
        <AlertCircle className="size-4 text-destructive" />
        <span>
          Failed to load models:{" "}
          {modelsQuery.error instanceof Error
            ? modelsQuery.error.message
            : "Unknown error"}
        </span>
      </div>
    );
  }

  const models = modelsQuery.data?.models || [];

  if (models.length === 0) {
    return (
      <div className="rounded border border-dashed p-8 text-center">
        <AlertCircle className="mx-auto size-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          No models available. Please configure a model provider in the Models
          page.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <Select
              value={selectedModel}
              onValueChange={(v) => setSelectedModel(v ?? undefined)}
            >
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem
                    key={`${m.providerId}/${m.modelId}`}
                    value={`${m.providerId}/${m.modelId}`}
                  >
                    {m.providerId}/{m.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="show-thinking"
              checked={showThinking}
              onCheckedChange={(checked) => setShowThinking(checked === true)}
            />
            <Label
              htmlFor="show-thinking"
              className="text-sm font-normal cursor-pointer"
            >
              Show thinking
            </Label>
          </div>
        </div>
      </div>

      <Card className="flex-1 flex flex-col min-h-0">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Chat</CardTitle>
            <div className="flex items-center gap-2">
              {agentInfoQuery.data && (
                <div className="text-xs text-muted-foreground">
                  Agent: {agentInfoQuery.data.name}
                </div>
              )}
              <ChatHistorySelector
                packageIdentifier={packageIdentifier}
                currentConversationId={conversationId}
                onConversationSelect={handleConversationSelect}
              />
              {conversationId && (
                <ShareConversationDialog
                  conversationId={conversationId}
                  conversationTitle={
                    conversationQuery.data?.title ?? "Conversation"
                  }
                />
              )}
              {messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleNewChat}
                  className="text-xs h-7"
                >
                  New Chat
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto mb-4 pr-2 overflow-x-hidden">
            {messages.length === 0 && !isStreaming && (
              <div className="text-center text-muted-foreground py-8">
                Start a conversation by asking a question about this package.
              </div>
            )}
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
                role={message.role}
                content={message.content}
                thinking={showThinking ? message.thinking : undefined}
                agentName={agentInfoQuery.data?.name}
              />
            ))}
            {isStreaming &&
              currentStreamingText &&
              !hasAddedFinalMessageRef.current && (
                <ChatMessage
                  role="assistant"
                  content={currentStreamingText}
                  isStreaming={true}
                  thinking={
                    showThinking ? currentStreamingThinking : undefined
                  }
                  isThinkingPhase={false}
                  agentName={agentInfoQuery.data?.name}
                />
              )}
            {isStreaming && !currentStreamingText && (
              <ChatMessage
                role="assistant"
                content=""
                isStreaming={true}
                thinking={
                  showThinking
                    ? (currentStreamingThinking ?? "")
                    : undefined
                }
                isThinkingPhase={showThinking}
                agentName={agentInfoQuery.data?.name}
              />
            )}
            <ChatTypingIndicator
              typingUsers={Array.from(typingUsers.values())}
            />
            <div ref={messagesEndRef} />
          </div>
          <ChatInput
            onSend={handleSendMessage}
            disabled={!selectedModel || modelsQuery.isLoading}
            queueCount={messageQueue.length}
            onTyping={
              conversationId
                ? (text) =>
                    broadcastTypingMutation.mutate({
                      conversationId: conversationId!,
                      text,
                      isTyping: text.length > 0,
                    })
                : undefined
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
