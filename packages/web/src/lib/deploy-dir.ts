/** A component's default deploy directory: the server's template with the project's and component's names. */
export function deployDirFor(template: string, project: string, component: string): string {
  return template.replaceAll("{project}", project).replaceAll("{component}", component);
}

/** The directory to show while the names are typed: none until both are there. */
export function suggestedDir(template: string | null, project: string, component: string): string {
  if (!template || project === "" || component === "") return "";
  return deployDirFor(template, project, component);
}
