/** Build-step entrypoint: exits before preflight if cloud env points elsewhere. */
import { assertStagingDatabaseTarget } from "./staging-db-target.mjs";

const target = assertStagingDatabaseTarget();
console.log(`Verified isolated staging database project ${target.projectRef}.`);
