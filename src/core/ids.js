import { customAlphabet } from "nanoid";

const alpha = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const nid21 = customAlphabet(alpha, 21);
const nid12 = customAlphabet(alpha, 12);

export const newTaskId = () => nid21();
export const newCommentId = () => nid21();
export const newRunId = () => nid21();
export const newProjectId = () => nid12();
export const newAgentLogId = () => nid21();
export const newEmbeddingId = () => nid21();
export const newProviderId = () => nid12();
export const newModelId = () => nid21();
export const newAutomationId = () => nid12();
export const newAutomationRunId = () => nid21();
export const newAutomationTriggerId = () => nid21();
export const newSlackInboundEventId = () => nid21();
export const newSlackDeliveryId = () => nid21();
export const newAssistantMessageId = () => nid21();
export const newAssistantThreadId = () => nid12();
