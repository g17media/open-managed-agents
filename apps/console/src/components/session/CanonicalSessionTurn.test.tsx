import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  projectCanonicalChatTurns,
  type CanonicalChatTurn,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import { CanonicalSessionTurn } from "./CanonicalSessionTurn";

describe("CanonicalSessionTurn", () => {
  it("projects Managed events through the OpenMA Agent UI turn", () => {
    const turn: CanonicalChatTurn = {
      id: "turn-1",
      status: "completed",
      userText: "Inspect the repository",
      rawEvents: [],
      render: {
        thoughtText: "Reading files",
        currentThoughtText: "",
        assistantText: "Everything looks good.",
        tools: [],
        plan: [],
        notes: [],
        timeline: [
          { kind: "thought", messageId: "thought-1", text: "Reading files" },
          { kind: "assistant_text", text: "Everything looks good." },
        ],
      },
    };

    const html = renderToStaticMarkup(<CanonicalSessionTurn turn={turn} />);

    expect(html).toContain('data-session-turn-status="completed"');
    expect(html).toContain('data-session-process-state="complete"');
    expect(html).toContain("Inspect the repository");
    expect(html).toContain("Reading files");
    expect(html).toContain("Everything looks good.");
  });

  it.each(["running", "completed"] as const)(
    "preserves complete message and thought text across tool calls in a %s turn",
    (status) => {
      const firstMessage = "I will check the existing site and its saved metadata before updating the weather. Only the weather data needs to change.";
      const nextMessage = "The existing design can stay. Updating the weather now.";
      const firstThought = "Checking the saved project metadata and current weather conditions.";
      const nextThought = "Ready to publish.";
      const finalMessage = "## Weather updated\n\nThe site is **live**.\n\n- Forecast refreshed\n- Metadata saved";
      const events: WireSessionEvent[] = [
        { id: "prompt", type: "user.message", content: [{ type: "text", text: "Update the weather site." }] },
        { type: "session.status_running" },
        { id: "message-1", type: "agent.message", content: [{ type: "text", text: firstMessage }] },
        { id: "thought-1", type: "agent.thinking", content: [{ type: "text", text: firstThought }] },
        { id: "tool-1", type: "agent.tool_use", name: "bash", input: { command: "ls" } },
        { type: "agent.tool_result", tool_use_id: "tool-1", content: "metadata.json" },
        { id: "message-2", type: "agent.message", content: [{ type: "text", text: nextMessage }] },
        { id: "thought-2", type: "agent.thinking", content: [{ type: "text", text: nextThought }] },
        { id: "tool-2", type: "agent.tool_use", name: "write", input: { path: "weather.json" } },
        { type: "agent.tool_result", tool_use_id: "tool-2", content: "Saved" },
        { id: "message-final", type: "agent.message", content: [{ type: "text", text: finalMessage }] },
        ...(status === "completed" ? [{ type: "session.status_idle" }] : []),
      ];
      const [turn] = projectCanonicalChatTurns(events);
      const html = renderToStaticMarkup(<CanonicalSessionTurn turn={turn!} />);
      const document = new DOMParser().parseFromString(html, "text/html");

      for (const text of [firstMessage, nextMessage, firstThought, nextThought]) {
        expect(document.body.textContent).toContain(text);
      }
      const answer = document.querySelector("[data-session-turn-answer]");
      expect(answer?.querySelector("h2")?.textContent).toBe("Weather updated");
      expect(answer?.querySelector("strong")?.textContent).toBe("live");
      expect(Array.from(answer?.querySelectorAll("li") ?? [], (li) => li.textContent))
        .toEqual(["Forecast refreshed", "Metadata saved"]);
      expect(answer?.textContent).not.toContain(firstMessage);
    },
  );
});
