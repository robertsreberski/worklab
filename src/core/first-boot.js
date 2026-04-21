import { cpSync, existsSync, readdirSync, mkdirSync } from "node:fs";

export function seedDataFromTemplate({ templateDir, dataDir }) {
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) return { seeded: false };
  if (!existsSync(templateDir)) return { seeded: false, reason: "no-template" };
  mkdirSync(dataDir, { recursive: true });
  cpSync(templateDir, dataDir, { recursive: true });
  return { seeded: true };
}
