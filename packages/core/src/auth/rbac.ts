/**
 * Who may do what. Administrators may do everything. Otherwise access is per
 * project: viewers read it, maintainers also change it. Anything not granted
 * here is denied.
 */

export type ProjectRole = "maintainer" | "viewer";
export type Action = "project:read" | "project:write" | "admin";

export interface Principal {
  isAdmin: boolean;
}

export function can(principal: Principal, action: Action, role: ProjectRole | null = null): boolean {
  if (principal.isAdmin) return true;
  switch (action) {
    case "admin":
      return false;
    case "project:write":
      return role === "maintainer";
    case "project:read":
      return role === "maintainer" || role === "viewer";
  }
}
