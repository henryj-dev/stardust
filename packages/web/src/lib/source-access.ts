/**
 * What the project form says about its repository: whether stardust can read
 * it, and a warning when it cannot or when the GitHub App reads too much.
 */

/** The answer of the access check, or why there is none. */
export type AccessView =
  | { repo: string; readable: "public" | "app" | "token" | "none"; installation?: "all" | "selected" }
  | { repo: string; error: string };

export function accessNote(view: AccessView): { text: string; warn: boolean } {
  if ("error" in view) return { text: `Could not check ${view.repo}: ${view.error}`, warn: true };
  switch (view.readable) {
    case "public":
      return { text: `${view.repo} is public: builds clone it without a token.`, warn: false };
    case "token":
      return { text: `${view.repo} is read with the configured token.`, warn: false };
    case "none":
      return {
        text: `stardust cannot read ${view.repo}: it is private and the GitHub App is not installed on it, or it does not exist. Install the App on it, or runs are refused.`,
        warn: true,
      };
    case "app":
      return view.installation === "all"
        ? {
            text: `${view.repo} is read through the GitHub App, which is installed on all of the owner's repositories. Narrow the installation to the ones stardust builds: its key reads every one.`,
            warn: true,
          }
        : { text: `${view.repo} is private, read through the GitHub App.`, warn: false };
  }
}
