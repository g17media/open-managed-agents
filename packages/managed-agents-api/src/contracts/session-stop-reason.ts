import { z } from "zod";

export const stopReasonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("end_turn") }).strict(),
  z.object({
    type: z.literal("requires_action"),
    action_type: z.enum(["tool_confirmation", "custom_tool_result"]).optional(),
    event_ids: z.array(z.string()),
  }).strict(),
  z.object({ type: z.literal("retries_exhausted") }).strict(),
  z.object({ type: z.literal("budget_reached") }).strict(),
]);
