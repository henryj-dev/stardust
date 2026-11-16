import type { FileMount } from "@stardust/sdk";

/**
 * The files a component's form asks to mount, in row order: `mounts.<i>.key`
 * and `mounts.<i>.path`. A row without a path is left out, so clearing a path
 * removes that file. The server checks keys and paths again.
 */
export function readMounts(form: FormData): FileMount[] {
  const rows = new Set<number>();
  for (const key of form.keys()) {
    const m = /^mounts\.(\d+)\./.exec(key);
    if (m) rows.add(Number(m[1]));
  }
  const mounts: FileMount[] = [];
  for (const i of [...rows].sort((a, b) => a - b)) {
    const key = String(form.get(`mounts.${i}.key`) ?? "").trim();
    const path = String(form.get(`mounts.${i}.path`) ?? "").trim();
    if (path === "") continue;
    mounts.push({ key, path });
  }
  return mounts;
}
