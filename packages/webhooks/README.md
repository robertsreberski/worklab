# `@worklab-ai/webhooks`

Reusable webhook helpers and an MCP stdio server for Worklab.

```js
import { sendWebhook } from "@worklab-ai/webhooks";

await sendWebhook({
  url: "https://example.test/webhook",
  data: { result: "done" },
});
```

The MCP server exposes `trigger_webhook`, which sends an unauthenticated JSON
`POST` to a URL supplied by the agent instructions.
