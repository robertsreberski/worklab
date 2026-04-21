import supertest from "supertest";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

export function makeTestServer() {
  const db = makeTestDb();
  const { app, broker } = createServer({ db, logger: undefined });
  return { app, broker, db, agent: supertest(app) };
}
