/**
 * Recovery commands, run inside the server container by someone who can
 * reach the deployment (kubectl exec). Access to the deployment is the
 * authority here, which is why this is not an HTTP endpoint.
 *
 *   node packages/server/src/admin.ts reset-password <username>
 *
 * The new password is read from standard input, never from arguments, so it
 * does not show up in the process list or shell history. All of the user's
 * sessions end.
 */
import { loadConfig } from "@stardust/config";
import { connect, migrate, resetPassword } from "@stardust/db";

const [command, username] = process.argv.slice(2);
if (command !== "reset-password" || !username) {
  console.error("usage: admin.ts reset-password <username>   (new password on standard input)");
  process.exit(2);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const password = Buffer.concat(chunks)
  .toString("utf8")
  .replace(/\r?\n$/, "");

const config = await loadConfig(process.env.STARDUST_CONFIG ?? "stardust.yaml");
const sql = connect(config.database.url, { max: 1 });
try {
  await migrate(sql);
  if (!(await resetPassword(sql, username, password))) {
    console.error(`no user "${username}"`);
    process.exitCode = 1;
  } else {
    console.log(`password of "${username}" reset; their sessions have ended`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
