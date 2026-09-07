import type { BetaManagedAgentsDeployment as Deployment } from "@anthropic-ai/sdk/resources/beta/deployments";

/** The message field edits the first text block, retaining attachments and other events. */
export function deploymentInitialMessage(deployment: Deployment): string {
  for (const event of deployment.initial_events) {
    if (event.type !== "user.message") continue;
    for (const block of event.content) if (block.type === "text") return block.text;
  }
  return "";
}

export function updateDeploymentMessage(deployment: Deployment, text: string): Deployment["initial_events"] {
  const events = structuredClone(deployment.initial_events);
  for (const event of events) {
    if (event.type !== "user.message") continue;
    for (const block of event.content) {
      if (block.type === "text") { block.text = text; return events; }
    }
  }
  events.push({ type: "user.message", content: [{ type: "text", text }] });
  return events;
}

export function deploymentMemoryResources(deployment: Deployment, selected: string[]): Deployment["resources"] {
  return [
    ...deployment.resources.filter((resource) => resource.type !== "memory_store"),
    ...selected.map((id) => deployment.resources.find((resource) => resource.type === "memory_store" && resource.memory_store_id === id)
      ?? { type: "memory_store" as const, memory_store_id: id, access: "read_write" as const }),
  ];
}
