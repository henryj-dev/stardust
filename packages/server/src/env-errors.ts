/** Errors of the env editor, in their own module so its helpers can raise them too. */
export class EnvInputError extends Error {}
export class EnvConflict extends Error {}
