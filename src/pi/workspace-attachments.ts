import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageAttachment } from "../domain/types.js";

export const WORKSPACE_ATTACHMENTS_CUSTOM_TYPE = "rp-agent/workspace_attachments";
export const MAX_WORKSPACE_ATTACHMENTS_PER_TURN = 8;

export type WorkspaceAttachmentMarkerDetails = {
  schemaVersion: 1;
  targetAssistantEntryId: string;
  attachments: MessageAttachment[];
};

export function createWorkspaceAttachmentMarker(
  targetAssistantEntryId: string,
  attachments: readonly MessageAttachment[],
  timestamp: number,
): AgentMessage {
  return {
    role: "custom",
    customType: WORKSPACE_ATTACHMENTS_CUSTOM_TYPE,
    content: "",
    display: false,
    details: {
      schemaVersion: 1,
      targetAssistantEntryId,
      attachments: attachments.slice(0, MAX_WORKSPACE_ATTACHMENTS_PER_TURN).map((attachment) => ({
        ...attachment,
      })),
    } satisfies WorkspaceAttachmentMarkerDetails,
    timestamp,
  };
}

export function workspaceAttachmentMarkerDetails(
  message: AgentMessage,
): WorkspaceAttachmentMarkerDetails | undefined {
  if (
    message.role !== "custom" ||
    message.customType !== WORKSPACE_ATTACHMENTS_CUSTOM_TYPE ||
    !isRecord(message.details) ||
    message.details.schemaVersion !== 1 ||
    typeof message.details.targetAssistantEntryId !== "string" ||
    !message.details.targetAssistantEntryId.trim() ||
    !Array.isArray(message.details.attachments)
  ) {
    return undefined;
  }
  const attachments = message.details.attachments.slice(0, MAX_WORKSPACE_ATTACHMENTS_PER_TURN)
    .flatMap((attachment) =>
      isRecord(attachment) && typeof attachment.path === "string" && attachment.path.trim()
        ? [{ path: attachment.path }]
        : []);
  if (!attachments.length) return undefined;
  return {
    schemaVersion: 1,
    targetAssistantEntryId: message.details.targetAssistantEntryId,
    attachments,
  };
}

export function isWorkspaceAttachmentMarker(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === WORKSPACE_ATTACHMENTS_CUSTOM_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
