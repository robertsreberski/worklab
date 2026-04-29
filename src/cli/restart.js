import { loadConfig, worklabBaseUrl } from "../core/config.js";
import { ensureServiceInstalled, restartUserService } from "./install-service.js";
import { buildUi, waitForHealth } from "./start.js";
import { applyConfigArgs, hasFlag } from "./args.js";
import { assertServiceRuntimeReady } from "./service-runtime.js";

export async function restart(args = []) {
  applyConfigArgs(args);
  const config = loadConfig();
  if (hasFlag(args, "--no-build")) {
    console.log("build: skipped");
  } else {
    buildUi(config);
  }
  const installed = await ensureServiceInstalled({ config });
  assertServiceRuntimeReady(config);
  await restartUserService({ config });
  const health = await waitForHealth(config);
  console.log(`worklab: restarted at ${worklabBaseUrl(config)} (${installed.file})`);
  return health;
}
