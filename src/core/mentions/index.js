// Public surface of the mentions domain. Edge layers (api, mcp,
// integrations) prefer importing from here over deep paths.

export {
  MENTION_TOKEN_RE,
  MENTION_TYPES,
  parseMentionToken,
  parseMentions,
  serializeMention,
  uniqueMentionTokens,
} from "./tokens.js";

export {
  resolveMentions,
  resolvedMentionsToObject,
} from "./resolver.js";

export {
  expandMentionsForLlm,
  expandMentionsInRecord,
} from "./expand.js";
