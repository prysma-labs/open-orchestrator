"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { AGENTS, type AgentId, agentById } from "@/lib/agents";
import type { ChatMessage, LatestRun } from "@/lib/types";

type ConversationState = {
  messages: ChatMessage[];
  latestRun: LatestRun | null;
};

function convertMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.content }],
  };
}

function ThreadWelcome({ name }: { name: string }) {
  return (
    <div className="mb-6 flex flex-col px-2">
      <p className="text-2xl font-medium tracking-tight">{name}</p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        Ask a question. This agent will say when it needs data it does not have.
      </p>
    </div>
  );
}

function AgentSidebar({
  agentId,
  onSelect,
}: {
  agentId: AgentId;
  onSelect: (id: AgentId) => void;
}) {
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-4">
        <p className="font-wordmark text-primary text-3xl leading-none">
          twosigma
        </p>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {AGENTS.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  type="button"
                  isActive={item.id === agentId}
                  className="h-auto items-start overflow-visible py-2 [&>span:last-child]:overflow-visible [&>span:last-child]:text-clip [&>span:last-child]:whitespace-normal"
                  aria-current={item.id === agentId ? "page" : undefined}
                  onClick={() => {
                    onSelect(item.id);
                    setOpenMobile(false);
                  }}
                >
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-muted-foreground text-xs font-normal whitespace-normal">
                      {item.blurb}
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

export function ResearchApp() {
  const [agentId, setAgentId] = useState<AgentId>("quant");
  const agent = agentById(agentId)!;

  return (
    <SidebarProvider className="h-full min-h-0">
      <AgentSidebar agentId={agentId} onSelect={setAgentId} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <Conversation key={agentId} agentId={agent.id} name={agent.name} />
      </SidebarInset>
    </SidebarProvider>
  );
}

function Conversation({ agentId, name }: { agentId: AgentId; name: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/agents/${agentId}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Could not load the conversation.");
    const data = (await response.json()) as ConversationState;
    setMessages(data.messages);
    const running = data.latestRun?.status === "running";
    setIsRunning(running);
    setFailure(
      data.latestRun?.status === "failed"
        ? (data.latestRun.error ?? "The run failed.")
        : null,
    );
    setLoaded(true);
    return running;
  }, [agentId]);

  const poll = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      const running = await refresh();
      if (running) timer.current = window.setTimeout(() => void poll(), 1500);
    } catch (error) {
      setLoaded(true);
      setFailure(
        error instanceof Error
          ? error.message
          : "Could not load the conversation.",
      );
    }
  }, [refresh]);

  useEffect(() => {
    void poll();
    return () => window.clearTimeout(timer.current);
  }, [poll]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const part = message.content[0];
      if (!part || part.type !== "text") return;
      setSendError(null);
      setIsRunning(true);
      const response = await fetch(`/api/agents/${agentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: part.text }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setIsRunning(false);
        setSendError(payload.error ?? "Could not send the message.");
        return;
      }
      await poll();
    },
    [agentId, poll],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    isLoading: !loaded,
    convertMessage,
    onNew,
  });

  const components = useMemo(
    () => ({
      Welcome: function Welcome() {
        return <ThreadWelcome name={name} />;
      },
    }),
    [name],
  );

  const banner = sendError ?? failure;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4 data-vertical:h-4" />
        <h1 className="text-sm font-medium">{name}</h1>
        <Badge
          variant={isRunning ? "default" : "secondary"}
          className="ml-auto"
        >
          {isRunning ? "Working" : "Idle"}
        </Badge>
      </header>
      <div className="font-chat flex min-h-0 flex-1 flex-col">
        {banner ? (
          <p role="alert" className="text-destructive px-4 py-2 text-sm">
            {banner}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread components={components} />
          </AssistantRuntimeProvider>
        </div>
      </div>
    </section>
  );
}
