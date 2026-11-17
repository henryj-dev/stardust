/**
 * Where a component's manifests go by default: a template in the deploy
 * repository's configuration, `{project}` and `{component}` filled in.
 * A component can still name any directory; this only saves typing one.
 */

const PLACEHOLDER = /\{([a-z]+)\}/g;

/** Why a template is not usable, or null when it is. */
export function checkDeployDirTemplate(template: unknown): string | null {
  if (typeof template !== "string" || template === "") return "must be a path like deploy/apps/{project}/{component}";
  if (template.startsWith("/") || template.endsWith("/"))
    return "must be a relative path without a leading or trailing slash";
  const names = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const unknown = names.find((n) => n !== "project" && n !== "component");
  if (unknown) return `{${unknown}} is not a placeholder: use {project} and {component}`;
  if (!names.includes("component")) return "must contain {component}, so components get directories of their own";
  const parts = template.replace(PLACEHOLDER, "x").split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || !/^[A-Za-z0-9._-]+$/.test(p))) {
    return "must be plain path segments (letters, digits, . _ -), without . or .. or empty parts";
  }
  return null;
}

/** The directory the template gives a component. */
export function deployDirFor(template: string, project: string, component: string): string {
  return template.replaceAll("{project}", project).replaceAll("{component}", component);
}
