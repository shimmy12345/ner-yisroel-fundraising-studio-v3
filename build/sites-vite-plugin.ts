import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const productionEnvironment = process.env.FUNDRAISING_OS_ENVIRONMENT === "production";
      const hostingConfig = resolve(root, ".openai", productionEnvironment ? "hosting.production.json" : "hosting.json");
      const productionBaseline = productionEnvironment || process.env.FUNDRAISING_OS_SCHEMA_TRACK === "production-baseline";
      const drizzleSource = productionBaseline ? resolve(root, "production-baseline", "drizzle") : resolve(root, "drizzle");

      if (productionEnvironment) {
        const [staging, production] = await Promise.all([
          readFile(resolve(root, ".openai", "hosting.json"), "utf8").then(JSON.parse),
          readFile(hostingConfig, "utf8").then(JSON.parse),
        ]);
        if (!production.project_id || production.project_id === staging.project_id) {
          throw new Error("Production packaging requires a distinct production project ID.");
        }
        if (production.d1 !== "DB") {
          throw new Error("Production packaging requires the DB binding.");
        }
      }

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
    },
  };
}
