"use client";

import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { Message } from "@/lib/types";

function toThread(message: Message): ThreadMessageLike {
  return {
    id: String(message.id),
    role: message.role,
    content: [{ type: "text", text: message.content }],
    status: message.status === "streaming"
      ? { type: "running" }
      : message.status === "failed"
        ? { type: "incomplete", reason: "error" }
        : { type: "complete", reason: "stop" },
  };
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-[var(--user)] px-4 py-2.5 text-[15px] leading-6">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="max-w-[46rem]">
      <MessagePrimitive.Parts components={{ Text: () => <MarkdownTextPrimitive className="answer" smooth={false} /> }} />
    </MessagePrimitive.Root>
  );
}

export function SharedThread({
  messages,
  running,
  notice,
  onSubmit,
  onCancel,
}: {
  messages: Message[];
  running: boolean;
  notice: string | null;
  onSubmit: (content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const threadMessages = useMemo(() => messages.map(toThread), [messages]);
  const runtime = useExternalStoreRuntime({
    messages: threadMessages,
    isRunning: false,
    convertMessage: (message) => message,
    onNew: async (message: AppendMessage) => {
      const part = message.content.find((item) => item.type === "text");
      const text = part && "text" in part ? part.text : "";
      await onSubmit(text);
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport autoScroll className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-8">
          {messages.length === 0 ? (
            <div className="mx-auto mt-16 max-w-lg text-center">
              <p className="text-2xl font-medium tracking-tight">One conversation. Everyone watching.</p>
              <p className="mt-3 text-[var(--muted)]">Send a message and the coordinator will put scout, implementer, and reviewer on it. The same history is visible in every window.</p>
            </div>
          ) : null}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <div className="px-4 pb-4 sm:px-8">
          {notice ? <p className="mb-2 text-sm text-red-200">{notice}</p> : null}
          <ComposerPrimitive.Root className="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl border border-[var(--line)] bg-[#121214] p-2 shadow-[0_20px_80px_rgba(0,0,0,0.35)]">
            <ComposerPrimitive.Input
              rows={1}
              placeholder="Message the shared workspace"
              aria-label="Message"
              className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-[#746f67]"
            />
            {running ? (
              <button type="button" onClick={onCancel} className="rounded-full px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--ink)]">
                Stop
              </button>
            ) : null}
            <ComposerPrimitive.Send className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-medium text-black disabled:opacity-40">
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
