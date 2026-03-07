import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function createFileBackedJobStore({ path }) {
  if (!path) {
    throw new Error("job store path is required");
  }

  function load() {
    if (!existsSync(path)) {
      return { jobs: {} };
    }

    return JSON.parse(readFileSync(path, "utf8"));
  }

  function save(snapshot) {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(tempPath, path);
  }

  return Object.freeze({
    path,

    get(jobId) {
      return load().jobs[jobId] ?? null;
    },

    list() {
      return Object.values(load().jobs);
    },

    upsert(job) {
      const snapshot = load();
      snapshot.jobs[job.id] = job;
      save(snapshot);
      return snapshot.jobs[job.id];
    },
  });
}
