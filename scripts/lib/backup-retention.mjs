// REAL (I/O-performing) implementation of
// lib/operations/calendar-schema-repair-apply.ts's RetainBackupDeps --
// shells out to gzip/gpg/aws, exactly the same tools and credentials the
// repo's own existing nightly-backup/monthly-restore-verify workflows
// already use for Staging. Deliberately kept separate from that pure
// module: this file performs real process spawns and file I/O, so it is
// NOT itself unit-tested -- tests/calendar-schema-repair-apply.test.mjs
// exercises retainBackupSecurely()'s own logic with injected fakes
// instead (per this round's own instruction: "Add synthetic tests for
// encryption/upload failures"). This file is the thin, deliberately
// small wiring layer between that pure logic and the real world.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // stderr from gzip/gpg/aws is operational metadata (exit codes,
    // "AccessDenied", "No such file") -- never the backup's own content,
    // which is passed by FILE PATH to every one of these commands, never
    // inlined as an argument or read into this process at all.
    throw new Error(`${command} ${args[0] ?? ""} failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

export function buildRealRetentionDeps({ bucket, endpointUrl, passphrase }) {
  return {
    compress(sourcePath, destPath) {
      const result = run("gzip", ["-c", sourcePath], { encoding: "buffer" });
      fs.writeFileSync(destPath, result.stdout);
    },

    encrypt(sourcePath, destPath) {
      const passfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "repair-0049-")), "passphrase");
      fs.writeFileSync(passfile, passphrase, { mode: 0o600 });
      try {
        run("gpg", ["--batch", "--yes", "--symmetric", "--cipher-algo", "AES256", "--passphrase-file", passfile, "--output", destPath, sourcePath]);
      } finally {
        try {
          run("shred", ["-u", passfile]);
        } catch {
          fs.rmSync(passfile, { force: true });
        }
        fs.rmSync(path.dirname(passfile), { recursive: true, force: true });
      }
    },

    upload(localPath, remoteKey) {
      run("aws", ["s3api", "put-object", "--endpoint-url", endpointUrl, "--bucket", bucket, "--key", remoteKey, "--body", localPath, "--content-type", "application/octet-stream"]);
    },

    // An independent read-back, never trusting the upload command's own
    // exit code alone: confirms the object actually exists in the
    // bucket AND that its ContentLength matches what was uploaded.
    verifyRemoteObject(remoteKey, expectedBytes) {
      let result;
      try {
        result = run("aws", ["s3api", "head-object", "--endpoint-url", endpointUrl, "--bucket", bucket, "--key", remoteKey]);
      } catch {
        return false;
      }
      let head;
      try {
        head = JSON.parse(result.stdout);
      } catch {
        return false;
      }
      return Number(head.ContentLength) === expectedBytes;
    },

    statSize(filePath) {
      return fs.statSync(filePath).size;
    },

    shred(filePath) {
      if (!fs.existsSync(filePath)) return;
      try {
        run("shred", ["-u", filePath]);
      } catch {
        fs.rmSync(filePath, { force: true });
      }
    },
  };
}
