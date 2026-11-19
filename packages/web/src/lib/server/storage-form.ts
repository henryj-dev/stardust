import type { StorageChange, StorageVolume } from "@stardust/sdk";

/**
 * The storage a component's form asks for: rows `volumes.<i>.name`,
 * `.mountPath`, `.size` and `.storageClass`, in row order; a row without a
 * mount path is left out (clearing it unmounts the volume, keeping its data).
 * `adopt` and `deleteData` are checked boxes; `fsGroup` blank removes it.
 * The server checks everything again.
 */
export function readStorageForm(form: FormData): StorageChange {
  const rows = new Set<number>();
  for (const key of form.keys()) {
    const m = /^volumes\.(\d+)\./.exec(key);
    if (m) rows.add(Number(m[1]));
  }
  const value = (key: string) => String(form.get(key) ?? "").trim();
  const volumes: StorageVolume[] = [];
  for (const i of [...rows].sort((a, b) => a - b)) {
    const mountPath = value(`volumes.${i}.mountPath`);
    if (mountPath === "") continue;
    const storageClass = value(`volumes.${i}.storageClass`);
    volumes.push({
      name: value(`volumes.${i}.name`),
      mountPath,
      size: value(`volumes.${i}.size`),
      ...(storageClass ? { storageClass } : {}),
    });
  }
  const list = (key: string) => form.getAll(key).map(String).filter(Boolean);
  const group = value("fsGroup");
  const adopt = list("adopt");
  const deleteData = list("deleteData");
  return {
    volumes,
    ...(adopt.length ? { adopt } : {}),
    ...(deleteData.length ? { deleteData } : {}),
    ...(form.has("fsGroup") ? { fsGroup: group === "" ? null : Number(group) } : {}),
  };
}
