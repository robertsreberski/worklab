import { startCoordinator } from "../coordinator.js";

export async function start() {
  await startCoordinator();
  // keep process alive
}
