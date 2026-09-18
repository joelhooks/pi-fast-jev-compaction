import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

const usage: Usage = {
  input: 1200,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1240,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const call: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "I will inspect the generated file." },
    {
      type: "toolCall",
      id: "fixture-call",
      name: "read",
      arguments: { path: "generated.txt" },
    },
  ],
  api: "openai-responses",
  provider: "openai",
  model: "fixture",
  usage,
  stopReason: "toolUse",
  timestamp: 2,
};

export const toolTranscript: AgentMessage[] = [
  { role: "user", content: "Find the relevant line.", timestamp: 1 },
  call,
  {
    role: "toolResult",
    toolCallId: "fixture-call",
    toolName: "read",
    content: [
      {
        type: "text",
        text: `important header\n${"generated row\n".repeat(300)}`,
      },
    ],
    isError: false,
    timestamp: 3,
  },
  {
    ...call,
    content: [{ type: "text", text: "The relevant line is in the header." }],
    stopReason: "stop",
    timestamp: 4,
  },
];
