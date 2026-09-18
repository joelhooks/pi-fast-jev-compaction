import {
  applyLedger,
  measureContextChars,
  type PersistedDecision,
} from "../src/ledger.ts";
import { toolTranscript } from "./tool-transcript.ts";

const decision: PersistedDecision = {
  toolCallId: "fixture-call",
  tool: "read",
  action: "drop_result",
  keepCall: 0.9,
  keepResult: 0.1,
};
const filtered = applyLedger(
  toolTranscript,
  new Map([[decision.toolCallId, decision]]),
  80
);

console.log(
  JSON.stringify(
    {
      messagesBefore: toolTranscript.length,
      messagesAfter: filtered.length,
      charactersBefore: measureContextChars(toolTranscript),
      charactersAfter: measureContextChars(filtered),
      rolesAfter: filtered.map((message) => message.role),
    },
    null,
    2
  )
);
