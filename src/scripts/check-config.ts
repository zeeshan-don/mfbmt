import { productionConfigProblems } from "@/lib/env";

const problems = productionConfigProblems();
if (problems.length === 0) {
  console.log("Configuration OK for production.");
  process.exit(0);
}

console.error("Production configuration problems:");
for (const problem of problems) {
  console.error(`  - ${problem.variable}: ${problem.problem}`);
}
process.exit(1);