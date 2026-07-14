/**
 * End-to-end smoke test for fit scoring against the REAL (prod) DB, over the
 * actual Express stack. Reasoning + HubSpot push are disabled so no external
 * service is hit and nothing is billed. Uses a namespaced throwaway tenant and
 * deletes every row it created in a finally block.
 *
 * Run:  npx ts-node src/scripts/smoke-scoring.ts
 */
import dotenv from "dotenv";
dotenv.config();

import request from "supertest";
import app from "../app";
import prisma from "../db/prisma";

const CLIENT = "__scoring_smoke__";
const KEY = process.env.API_KEY;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const CONFIG = {
  client_id: CLIENT,
  criteria: [
    {
      key: "total_enrollment",
      type: "numeric_tiers",
      weight: 0.4,
      tiers: [
        { min: 0, max: 1000, score: 20 },
        { min: 1000, max: 5000, score: 60 },
        { min: 5000, max: 18000, score: 90 },
        { min: 18000, max: null, score: 100 },
      ],
    },
    { key: "propensity_to_spend", type: "passthrough", weight: 0.3 },
    {
      key: "median_household_income",
      type: "numeric_tiers",
      weight: 0.15,
      tiers: [
        { min: 0, max: 50000, score: 40 },
        { min: 50000, max: 75000, score: 70 },
        { min: 75000, max: 100000, score: 90 },
        { min: 100000, max: null, score: 100 },
      ],
    },
    {
      key: "enrollment_trend",
      type: "categorical",
      weight: 0.15,
      map: { growing: 100, stable: 60, declining: 20 },
      default: 0,
    },
  ],
  // Disabled so /score never calls OpenAI; bands still resolve the recommendation.
  reasoning: {
    enabled: false,
    recommendation_bands: [
      { min: 80, max: 100, label: "Prioritize now" },
      { min: 65, max: 79, label: "Worth a call" },
      { min: 50, max: 64, label: "Enrich first" },
      { min: 0, max: 49, label: "Deprioritize" },
    ],
  },
};

async function cleanup() {
  await prisma.scoreResult.deleteMany({ where: { client_id: CLIENT } });
  await prisma.scoringConfig.deleteMany({ where: { client_id: CLIENT } });
}

async function main() {
  if (!KEY) throw new Error("API_KEY not set in .env — cannot smoke test the auth'd endpoints");
  const auth = { Authorization: `Bearer ${KEY}` };

  // Start clean in case a previous run aborted before cleanup.
  await cleanup();

  console.log("PUT /config (create) ...");
  const put1 = await request(app).put(`/config/${CLIENT}`).set(auth).send(CONFIG);
  check("PUT returns 200", put1.status === 200, put1.body);
  check("config_version starts at 1", put1.body?.config_version === 1, put1.body?.config_version);

  console.log("GET /config ...");
  const get1 = await request(app).get(`/config/${CLIENT}`).set(auth);
  check("GET returns 200", get1.status === 200, get1.status);
  check("GET version is 1", get1.body?.config_version === 1, get1.body?.config_version);
  check("GET criteria round-tripped", get1.body?.config?.criteria?.length === 4);

  console.log("PUT /config (update → version bump) ...");
  const put2 = await request(app).put(`/config/${CLIENT}`).set(auth).send(CONFIG);
  check("second PUT bumps to version 2", put2.body?.config_version === 2, put2.body?.config_version);

  console.log("PUT /config with invalid weights (must reject, not store) ...");
  const bad = { ...CONFIG, criteria: [{ ...CONFIG.criteria[0], weight: 0.9 }, CONFIG.criteria[1]] };
  const putBad = await request(app).put(`/config/${CLIENT}`).set(auth).send(bad);
  check("invalid config returns 422", putBad.status === 422, putBad.status);
  check("422 carries an errors list", Array.isArray(putBad.body?.errors), putBad.body);
  const stillV2 = await request(app).get(`/config/${CLIENT}`).set(auth);
  check("rejected config was NOT stored (still v2)", stillV2.body?.config_version === 2, stillV2.body?.config_version);

  // Required identity properties on every /fit-score call.
  const ID = {
    account_name: "Smoke District",
    account_domain: "smoke.example.org",
    starbridge_id: "SB-SMOKE-1",
  };

  console.log("POST /fit-score (hand-computed = 83) ...");
  const values = {
    total_enrollment: 8200,
    propensity_to_spend: 72,
    median_household_income: 68000,
    enrollment_trend: "growing",
  };
  const score1 = await request(app).post(`/fit-score`).set(auth).send({ client_id: CLIENT, ...ID, values });
  check("score returns 200", score1.status === 200, score1.body);
  check("final_score is 83", score1.body?.final_score === 83, score1.body?.final_score);
  check("recommendation resolved", score1.body?.recommendation === "Prioritize now", score1.body?.recommendation);
  check("config_version is 2 (latest)", score1.body?.config_version === 2, score1.body?.config_version);
  check("cached:false on first score", score1.body?.cached === false, score1.body?.cached);
  check("per_criterion has 4 rows", score1.body?.per_criterion?.length === 4);
  check("account echoed back", score1.body?.account?.starbridge_id === "SB-SMOKE-1", score1.body?.account);

  console.log("POST /fit-score again (cache hit) ...");
  const score2 = await request(app).post(`/fit-score`).set(auth).send({ client_id: CLIENT, ...ID, values });
  check("cached:true on repeat", score2.body?.cached === true, score2.body?.cached);
  check("same final_score", score2.body?.final_score === 83, score2.body?.final_score);

  console.log("/score alias still works ...");
  const alias = await request(app).post(`/score`).set(auth).send({ client_id: CLIENT, ...ID, values });
  check("/score alias → 200, same score", alias.status === 200 && alias.body?.final_score === 83, alias.status);

  console.log("POST /fit-score missing identity (422) ...");
  const noId = await request(app).post(`/fit-score`).set(auth).send({ client_id: CLIENT, values });
  check("missing identity → 422", noId.status === 422, noId.status);
  check("lists missing_fields (3)", Array.isArray(noId.body?.missing_fields) && noId.body.missing_fields.length === 3, noId.body);

  console.log("reasoning:false suppresses generation (still scores) ...");
  const noReason = await request(app)
    .post(`/fit-score`)
    .set(auth)
    .send({ client_id: CLIENT, ...ID, values: { ...values, total_enrollment: 400 }, reasoning: false });
  check("reasoning:false → 200 with a score", noReason.status === 200 && typeof noReason.body?.final_score === "number", noReason.body);

  console.log("POST /fit-score missing required criterion key (422) ...");
  const score422 = await request(app)
    .post(`/fit-score`)
    .set(auth)
    .send({ client_id: CLIENT, ...ID, values: { total_enrollment: 8200 } });
  check("returns 422", score422.status === 422, score422.status);
  check("lists missing_keys", Array.isArray(score422.body?.missing_keys) && score422.body.missing_keys.length === 3, score422.body);

  console.log("POST /fit-score present-but-null value (scored, flagged, no 422) ...");
  const scoreNull = await request(app)
    .post(`/fit-score`)
    .set(auth)
    .send({ client_id: CLIENT, ...ID, values: { ...values, propensity_to_spend: null } });
  check("null value → 200 (not 422)", scoreNull.status === 200, scoreNull.status);
  const propRow = scoreNull.body?.per_criterion?.find((c: any) => c.key === "propensity_to_spend");
  check("null value flagged missing", propRow?.missing === true, propRow);

  console.log("POST /fit-score unknown client (404) ...");
  const s404 = await request(app).post(`/fit-score`).set(auth).send({ client_id: "__nope__", ...ID, values });
  check("unknown client → 404", s404.status === 404, s404.status);

  console.log("push_to_hubspot without config (422) ...");
  const pushBad = await request(app)
    .post(`/fit-score`)
    .set(auth)
    .send({ client_id: CLIENT, ...ID, values, push_to_hubspot: true, hubspot_object_id: "1" });
  check("push without hubspot_push config → 422", pushBad.status === 422, pushBad.status);

  console.log("auth rejection ...");
  const noAuth = await request(app).get(`/config/${CLIENT}`);
  check("missing auth → 401", noAuth.status === 401, noAuth.status);
}

main()
  .catch((e) => {
    failures++;
    console.error("FATAL", e);
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\n✅ SMOKE PASSED" : `\n❌ SMOKE FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
